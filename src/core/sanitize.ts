/**
 * 外泄防护的第三道：任何内容离开引擎之前都要过这里。
 *
 * 攻击链是：PR 里的文字诱导 finder 去读敏感文件，finder 把内容写进发现正文，
 * 再由发布阶段发到 PR 上。第一道（读不到）与第二道（写不进）在适配器与工具层，
 * 这一道是最后兜底，因为它同时能拦住前两道漏下来的东西。
 *
 * 命中不丢弃内容，而是把发现置为 held 等人处理——静默丢弃会让人误以为
 * 引擎没发现问题，那比误报更危险。
 */

/** 命中一条规则。 */
export interface SanitizeHit {
  rule: string
  /** 命中处的片段摘要，只留前若干字符，避免把秘密写进日志。 */
  excerpt: string
}

export interface SanitizeResult {
  clean: boolean
  hits: SanitizeHit[]
  /** 脱敏后的文本：命中处替换为占位符。 */
  text: string
}

const SECRET_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: 'gitcode-token', pattern: /\b(?:glpat|gcpat)-[A-Za-z0-9_-]{16,}\b/ },
  { rule: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'authorization-header', pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/i },
  { rule: 'password-assignment', pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i },
  { rule: 'secret-assignment', pattern: /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|token)\s*[:=]\s*\S{8,}/i },
  { rule: 'home-path', pattern: /\/(?:root|home\/[A-Za-z0-9._-]+)\/[A-Za-z0-9._\/-]{3,}/ },
  { rule: 'internal-host', pattern: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2,3}\b/ },
  { rule: 'internal-domain', pattern: /\b[A-Za-z0-9-]+\.(?:huawei\.com|rnd\.huawei\.com|local)\b/i },
]

/** 长度超过 32 且字符分布像随机串的片段，视为高熵串。 */
const HIGH_ENTROPY = /[A-Za-z0-9+/_-]{32,}/g

/** 高熵判断：不同字符比例与是否有大小写数字混合。 */
function looksRandom(value: string): boolean {
  const distinct = new Set(value).size
  if (distinct < 12) return false
  const hasUpper = /[A-Z]/.test(value)
  const hasLower = /[a-z]/.test(value)
  const hasDigit = /\d/.test(value)
  return hasUpper && hasLower && hasDigit
}

/** 扫描并脱敏一段文本。 */
export function sanitize(input: string): SanitizeResult {
  const hits: SanitizeHit[] = []
  let text = input

  for (const { rule, pattern } of SECRET_RULES) {
    const match = pattern.exec(text)
    if (!match) continue
    hits.push({ rule, excerpt: match[0].slice(0, 12) + '…' })
    text = text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'), '[REDACTED]')
  }

  text = text.replace(HIGH_ENTROPY, candidate => {
    if (!looksRandom(candidate)) return candidate
    hits.push({ rule: 'high-entropy', excerpt: candidate.slice(0, 8) + '…' })
    return '[REDACTED]'
  })

  return { clean: hits.length === 0, hits, text }
}

/** 一条发现要不要被扣下。命中即 held，并记一条安全事件。 */
export function sanitizeFinding(finding: {
  title: string
  trigger: string
  outcome: string
  evidence?: string
}): { held: boolean; hits: SanitizeHit[]; redacted: { title: string; trigger: string; outcome: string } } {
  const parts = [finding.title, finding.trigger, finding.outcome, finding.evidence ?? '']
  const results = parts.map(part => sanitize(part))
  const hits = results.flatMap(result => result.hits)
  return {
    held: hits.length > 0,
    hits,
    redacted: {
      title: results[0].text,
      trigger: results[1].text,
      outcome: results[2].text,
    },
  }
}
