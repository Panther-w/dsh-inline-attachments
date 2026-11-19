/**
 * Host half of dsh-inline-attachments (pure functions, no DSH imports).
 *
 * The client serializes every inline attachment chip as an invisible marker:
 *   U+2063 (INVISIBLE SEPARATOR) + N × U+200B (ZERO WIDTH SPACE) + U+2063
 * where N is the 1-based attachment position in the submitted content. An
 * a visible [图片N]/[文件N] placeholder keeps the sent text readable while the
 * invisible marker still carries the position; the rewrite also pads the placeholder
 * with single spaces; only
 * the Host sees the marker, and it removes every marker before append.
 *
 * The loop appends the pre-step batch as the durable `user/message`, so
 * rewriting here changes both the model input and the session log.
 *
 * @module dsh-inline-attachments/host
 */

/** Invisible marker: two U+2063 sentinels around N zero-width spaces. */
export const MARKER = /\u2063(\u200B*)\u2063/g

/** Sentinel used to detect a marker without running the global regular expression. */
const SENTINEL = '\u2063'

/** @param {unknown} block */
function isAttachment(block) {
  return block !== null && typeof block === 'object' && (block.type === 'image' || block.type === 'file')
}

/** @param {unknown} block */
function isText(block) {
  return block !== null && typeof block === 'object' && block.type === 'text'
}

/** @param {unknown} block */
function hasMarker(block) {
  return isText(block) && typeof block.text === 'string' && block.text.includes(SENTINEL)
}

/**
 * Recursively freeze a plain value; already-frozen and cyclic values are safe.
 * @template T
 * @param {T} value
 * @param {Set<object>} [seen]
 * @returns {T}
 */
export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return Object.freeze(value)
}

/**
 * Replace invisible markers with the corresponding attachment blocks.
 * Markers are stripped even when the message carries no attachment at all.
 *
 * @param {readonly any[]} content
 * @returns {{ content: any[], changed: boolean }}
 */
export function rewriteContent(content) {
  if (!Array.isArray(content)) return { content: [], changed: false }
  const attachments = content.filter(isAttachment)

  let changed = false
  const used = new Set()
  const next = []

  for (const block of content) {
    if (!isText(block)) {
      /* Attachments move to their marker positions; every other block keeps its place. */
      if (!isAttachment(block)) next.push(block)
      continue
    }
    const text = typeof block.text === 'string' ? block.text : ''
    if (!text.includes(SENTINEL)) {
      if (text !== '') next.push(block)
      continue
    }

    MARKER.lastIndex = 0
    let cursor = 0
    let match
    while ((match = MARKER.exec(text)) !== null) {
      changed = true
      const before = text.slice(cursor, match.index)
      if (before !== '') next.push({ type: 'text', text: before })
      const index = match[1].length
      if (index >= 1 && index <= attachments.length && !used.has(index - 1)) {
        next.push(attachments[index - 1])
        used.add(index - 1)
      }
      /* Index 0 and out-of-range markers are dropped on purpose. */
      cursor = match.index + match[0].length
    }
    const after = text.slice(cursor)
    if (after !== '') next.push({ type: 'text', text: after })
  }

  if (!changed) return { content: [...content], changed: false }

  // 占位前后各留一个空格，正文不粘字；已有空白不重复加。
  // 正文首块不加前导空格（DSH 自己会对首 token trimStart，加了也会被去掉）。
  for (let i = 0; i < next.length; i += 1) {
    if (!isAttachment(next[i])) continue
    const prev = next[i - 1]
    if (isText(prev) && typeof prev.text === 'string') {
      // 图片/文件占位，以及核心服务缺失时的 [附件] 降级占位。
      let spaced = prev.text.replace(/(?<!\s)(\[(?:(?:图片|文件)\d+|附件)\])$/u, ' $1')
      // 消息以占位开头时不补前导空格（DSH 会对首 token trimStart，加了也是噪声）。
      if (i - 1 === 0 && spaced.startsWith(' ') && !prev.text.startsWith(' ')) spaced = spaced.slice(1)
      if (spaced !== prev.text) next[i - 1] = { type: 'text', text: spaced }
    }
    const following = next[i + 1]
    if (isText(following) && typeof following.text === 'string'
      && following.text !== '' && !/^\s/u.test(following.text)) {
      next[i + 1] = { type: 'text', text: ` ${following.text}` }
    }
  }

  /* Never lose an attachment the user did not place: append unreferenced ones. */
  for (let index = 0; index < attachments.length; index += 1) {
    if (!used.has(index)) next.push(attachments[index])
  }

  const merged = []
  for (const block of next) {
    const previous = merged[merged.length - 1]
    if (isText(block) && isText(previous)) {
      merged[merged.length - 1] = { type: 'text', text: previous.text + block.text }
    } else {
      merged.push(block)
    }
  }
  return { content: merged, changed: true }
}

/**
 * Rewrite one user message, preserving its identity and source.
 * @param {any} message
 * @returns {any}
 */
export function rewriteMessage(message) {
  if (message === null || typeof message !== 'object') return message
  if (message.source === null || typeof message.source !== 'object' || message.source.kind !== 'user') return message
  const content = message.content
  if (!Array.isArray(content) || !content.some(hasMarker)) return message
  const result = rewriteContent(content)
  if (!result.changed) return message
  return deepFreeze({ ...message, content: result.content })
}
