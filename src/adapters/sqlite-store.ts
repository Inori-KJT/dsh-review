/**
 * SQLite 存储。用 Node 内置的 node:sqlite，不引入第三方依赖。
 *
 * 三条设计决定的理由：
 *   1 runs 表对 (repo, pr, review_kind, head_sha) 建唯一索引，
 *     让"同一 head 只评一次"由数据库而不是调用方保证。
 *   2 events 只追加不修改，是进度可视化与审计的唯一数据源。
 *   3 findings 带 fingerprint 与 head_sha，使"跨轮次是不是同一个问题"
 *     与"它属于哪个代码版本"可以分别查询。
 *
 * 这个文件属于 adapters，因此允许 import node:*；core 仍然纯净。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  Feedback, Finding, Run, RunEvent, RunStatus, StageExec, Vote, ReviewKind,
} from '../core/model.ts'
import type { PriorFindingState, StorePort } from '../core/ports.ts'

const SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  pr INTEGER NOT NULL,
  review_kind TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  since_sha TEXT,
  target TEXT NOT NULL,
  depth TEXT NOT NULL,
  mode TEXT NOT NULL,
  round INTEGER NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  usage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  progress TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_identity ON runs(repo, pr, review_kind, head_sha);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS stage_execs (
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  session_ids TEXT NOT NULL,
  usage TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (run_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  review_kind TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  defect_location TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  outcome_text TEXT NOT NULL,
  causal_evidence TEXT NOT NULL,
  introduced_by_change TEXT NOT NULL,
  finder_profile TEXT NOT NULL,
  finder_session_id TEXT,
  status TEXT NOT NULL,
  reopened_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_fingerprint ON findings(fingerprint);
CREATE INDEX IF NOT EXISTS findings_run ON findings(run_id);

CREATE TABLE IF NOT EXISTS votes (
  finding_id TEXT NOT NULL,
  verifier_session_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reproduces_on_base TEXT NOT NULL,
  evidence TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (finding_id, verifier_session_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  finding_id TEXT NOT NULL,
  source TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT,
  by_who TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (finding_id, source, by_who, at)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);

CREATE TABLE IF NOT EXISTS config_versions (
  revision INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  author TEXT NOT NULL,
  at TEXT NOT NULL
);
`

/** 用 node:sqlite 实现的 StorePort。 */
export class SqliteStore implements StorePort {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(DDL)
    this.db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION))
  }

  async insertRun(run: Run): Promise<void> {
    this.db.prepare(`INSERT INTO runs
      (id, repo, repo_path, pr, review_kind, head_sha, base_sha, since_sha, target, depth, mode, round,
       status, cursor, config_revision, trigger, usage, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.id, run.repo, run.repoPath, run.pr, run.reviewKind, run.headSha, run.baseSha, run.since ?? null,
      JSON.stringify(run.target), run.depth, run.mode, run.round,
      run.status, run.cursor, run.configRevision, run.trigger, JSON.stringify(run.usage),
      run.createdAt, run.updatedAt,
    )
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
    return row ? toRun(row) : undefined
  }

  async findRunByHead(repo: string, pr: number, reviewKind: ReviewKind, headSha: string): Promise<Run | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM runs WHERE repo = ? AND pr = ? AND review_kind = ? AND head_sha = ?',
    ).get(repo, pr, reviewKind, headSha) as Record<string, unknown> | undefined
    return row ? toRun(row) : undefined
  }

  async updateRun(run: Run): Promise<void> {
    this.db.prepare(`UPDATE runs SET status = ?, cursor = ?, round = ?, depth = ?, mode = ?,
      usage = ?, updated_at = ? WHERE id = ?`).run(
      run.status, run.cursor, run.round, run.depth, run.mode,
      JSON.stringify(run.usage), run.updatedAt, run.id,
    )
  }

  async listRuns(filter?: { statuses?: RunStatus[]; limit?: number }): Promise<Run[]> {
    const statuses = filter?.statuses
    const limit = filter?.limit ?? 100
    const sql = statuses && statuses.length > 0
      ? `SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`
      : 'SELECT * FROM runs ORDER BY created_at DESC LIMIT ?'
    const params = statuses && statuses.length > 0 ? [...statuses, limit] : [limit]
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(toRun)
  }

  async runsInLast24h(repo: string, pr: number, now: number): Promise<number> {
    const since = new Date(now - 24 * 3_600_000).toISOString()
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM runs WHERE repo = ? AND pr = ? AND created_at >= ?',
    ).get(repo, pr, since) as { n: number } | undefined
    return row?.n ?? 0
  }

  async recordStage(exec: StageExec): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO stage_execs
      (run_id, stage, attempt, status, started_at, ended_at, session_ids, usage, error)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      exec.runId, exec.stage, exec.attempt, exec.status,
      exec.startedAt ?? null, exec.endedAt ?? null,
      JSON.stringify(exec.sessionIds), JSON.stringify(exec.usage), exec.error ?? null,
    )
  }

  async listStages(runId: string): Promise<StageExec[]> {
    const rows = this.db.prepare('SELECT * FROM stage_execs WHERE run_id = ? ORDER BY stage, attempt').all(runId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      runId: String(row.run_id),
      stage: String(row.stage) as StageExec['stage'],
      attempt: Number(row.attempt),
      status: String(row.status) as StageExec['status'],
      startedAt: row.started_at ? String(row.started_at) : undefined,
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      sessionIds: JSON.parse(String(row.session_ids)) as string[],
      usage: JSON.parse(String(row.usage)) as StageExec['usage'],
      error: row.error ? String(row.error) : undefined,
    }))
  }

  async insertFinding(finding: Finding): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO findings
      (id, run_id, fingerprint, fingerprint_version, head_sha, review_kind, category, severity, title,
       defect_location, trigger_text, outcome_text, causal_evidence, introduced_by_change,
       finder_profile, finder_session_id, status, reopened_from, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      finding.id, finding.runId, finding.fingerprint, finding.fingerprintVersion, finding.headSha,
      finding.reviewKind, finding.category, finding.severity, finding.title,
      JSON.stringify(finding.defectLocation), finding.trigger, finding.outcome,
      JSON.stringify(finding.causalEvidence), finding.introducedByChange,
      finding.finderProfile, finding.finderSessionId ?? null, finding.status,
      finding.reopenedFrom ?? null, finding.createdAt, finding.updatedAt,
    )
  }

  async updateFindingStatus(findingId: string, status: Finding['status']): Promise<void> {
    this.db.prepare('UPDATE findings SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), findingId)
  }

  async listFindings(runId: string): Promise<Finding[]> {
    const rows = this.db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId) as Array<Record<string, unknown>>
    return rows.map(toFinding)
  }

  async priorFindingState(repo: string, pr: number, fingerprint: string): Promise<PriorFindingState | undefined> {
    const row = this.db.prepare(`
      SELECT f.status AS status, fb.verdict AS verdict
      FROM findings f
      JOIN runs r ON r.id = f.run_id
      LEFT JOIN feedback fb ON fb.finding_id = f.id
      WHERE r.repo = ? AND r.pr = ? AND f.fingerprint = ?
      ORDER BY f.created_at DESC, fb.at DESC
      LIMIT 1
    `).get(repo, pr, fingerprint) as { status: string; verdict: string | null } | undefined
    if (!row) return undefined
    if (row.verdict === 'false-positive') return 'false-positive'
    if (row.verdict === 'intended') return 'intended'
    if (row.verdict === 'unimportant') return 'unimportant'
    switch (row.status) {
      case 'published': return 'open'
      case 'resolved': return 'resolved'
      case 'dismissed': return 'dismissed'
      default: return 'open'
    }
  }

  async insertVote(vote: Vote): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO votes
      (finding_id, verifier_session_id, verdict, reproduces_on_base, evidence, at)
      VALUES (?,?,?,?,?,?)`).run(
      vote.findingId, vote.verifierSessionId, vote.verdict, vote.reproducesOnBase,
      vote.evidence ?? null, vote.at,
    )
  }

  async listVotes(findingId: string): Promise<Vote[]> {
    const rows = this.db.prepare('SELECT * FROM votes WHERE finding_id = ? ORDER BY at').all(findingId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      findingId: String(row.finding_id),
      verifierSessionId: String(row.verifier_session_id),
      verdict: String(row.verdict) as Vote['verdict'],
      reproducesOnBase: String(row.reproduces_on_base) as Vote['reproducesOnBase'],
      evidence: row.evidence ? String(row.evidence) : undefined,
      at: String(row.at),
    }))
  }

  async insertFeedback(feedback: Feedback): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO feedback
      (finding_id, source, verdict, note, by_who, actor_type, at) VALUES (?,?,?,?,?,?,?)`).run(
      feedback.findingId, feedback.source, feedback.verdict, feedback.note ?? null,
      feedback.by, feedback.actorType, feedback.at,
    )
  }

  async listFeedback(findingId: string): Promise<Feedback[]> {
    const rows = this.db.prepare('SELECT * FROM feedback WHERE finding_id = ? ORDER BY at').all(findingId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      findingId: String(row.finding_id),
      source: String(row.source) as Feedback['source'],
      verdict: String(row.verdict) as Feedback['verdict'],
      note: row.note ? String(row.note) : undefined,
      by: String(row.by_who),
      actorType: String(row.actor_type) as Feedback['actorType'],
      at: String(row.at),
    }))
  }

  async appendEvent(event: Omit<RunEvent, 'seq'>): Promise<number> {
    const info = this.db.prepare('INSERT INTO events (run_id, at, type, payload) VALUES (?,?,?,?)')
      .run(event.runId, event.at, event.type, JSON.stringify(event.payload))
    return Number(info.lastInsertRowid)
  }

  async listEvents(runId: string, sinceSeq = 0): Promise<RunEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, sinceSeq) as Array<Record<string, unknown>>
    return rows.map(row => ({
      seq: Number(row.seq),
      runId: String(row.run_id),
      at: String(row.at),
      type: String(row.type),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    }))
  }

  async saveProgress(runId: string, progress: string): Promise<void> {
    this.db.prepare('UPDATE runs SET progress = ? WHERE id = ?').run(progress, runId)
  }

  async loadProgress(runId: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT progress FROM runs WHERE id = ?').get(runId) as { progress: string | null } | undefined
    return row?.progress ?? undefined
  }
  async close(): Promise<void> {
    this.db.close()
  }
}

function toRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    target: JSON.parse(String(row.target)) as Run['target'],
    repo: String(row.repo),
    repoPath: String(row.repo_path),
    pr: Number(row.pr),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    since: row.since_sha ? String(row.since_sha) : undefined,
    reviewKind: String(row.review_kind) as Run['reviewKind'],
    depth: String(row.depth) as Run['depth'],
    mode: String(row.mode) as Run['mode'],
    round: Number(row.round),
    status: String(row.status) as Run['status'],
    cursor: String(row.cursor) as Run['cursor'],
    configRevision: Number(row.config_revision),
    trigger: String(row.trigger) as Run['trigger'],
    usage: JSON.parse(String(row.usage)) as Run['usage'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function toFinding(row: Record<string, unknown>): Finding {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    fingerprintVersion: Number(row.fingerprint_version),
    headSha: String(row.head_sha),
    runId: String(row.run_id),
    reviewKind: String(row.review_kind) as Finding['reviewKind'],
    category: String(row.category) as Finding['category'],
    severity: String(row.severity) as Finding['severity'],
    title: String(row.title),
    defectLocation: JSON.parse(String(row.defect_location)) as Finding['defectLocation'],
    trigger: String(row.trigger_text),
    outcome: String(row.outcome_text),
    causalEvidence: JSON.parse(String(row.causal_evidence)) as Finding['causalEvidence'],
    introducedByChange: String(row.introduced_by_change) as Finding['introducedByChange'],
    finderProfile: String(row.finder_profile),
    finderSessionId: row.finder_session_id ? String(row.finder_session_id) : undefined,
    status: String(row.status) as Finding['status'],
    reopenedFrom: row.reopened_from ? String(row.reopened_from) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
