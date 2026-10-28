/**
 * Recall over archived windows.
 *
 * A rollover does not delete anything: the replaced events stay in the session
 * log at their original seqs, and each `compaction/summary` event records which
 * seqs it replaced. That record is the archive index — it survives resume and
 * fork without any side storage, and it is what the recall tools read.
 *
 * Items are named the way the reference implementations name them: a window
 * ordinal, then the item's position inside that window.
 *
 * @module dsh-compaction-sticky-window/history
 */

/** Separator between a window ordinal and an item ordinal in a recall id. */
const ITEM_ID_SEPARATOR = ':'
/** Marker prefix used when an id is echoed back to the model. */
export const ITEM_ID_PREFIX = 'w'

/**
 * Read the visible text of one derived message.
 * @param {object} message - any conversation message.
 * @returns {string} its text blocks joined by newlines.
 */
function messageText(message) {
  /** @type {string[]} */
  const parts = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`${block.name}(${block.arguments})`)
  }
  return parts.join('\n')
}

/**
 * Build the archive index for one session.
 *
 * Each `compaction/summary` event opens one window; its `shadowedSeqs` are the
 * items in that window, in the order they appeared on the surface.
 * @param {object} session - the session whose log holds the archive.
 * @returns {{ windows: object[], items: Map<string, object> }} the index.
 */
export function collectArchive(session) {
  /** @type {object[]} */
  const windows = []
  /** @type {Map<string, object>} */
  const items = new Map()
  let ordinal = 0
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'compaction/summary') continue
    ordinal += 1
    const windowId = `${ordinal}`
    /** @type {object[]} */
    const windowItems = []
    const seqs = event.data.shadowedSeqs ?? []
    for (const [position, seq] of seqs.entries()) {
      const source = session.eventAt(seq)
      if (source === undefined) continue
      const message = session.deriveEventMessage(source)
      if (message === null) continue
      const text = messageText(message)
      if (text.length === 0) continue
      const id = `${ITEM_ID_PREFIX}${windowId}${ITEM_ID_SEPARATOR}${position}`
      const item = {
        id,
        window: ordinal,
        role: message.role,
        bytes: Buffer.byteLength(text, 'utf8'),
        time: source.time,
        text,
      }
      windowItems.push(item)
      items.set(id, item)
    }
    windows.push({
      window: ordinal,
      compactionId: event.data.compactionId,
      items: windowItems.length,
      shadowedTokenCount: event.data.shadowedTokenCount,
      firstTime: windowItems[0]?.time ?? event.time,
      lastTime: windowItems[windowItems.length - 1]?.time ?? event.time,
      provider: event.data.provider,
    })
  }
  return { windows, items }
}

/**
 * Describe the archive without returning any archived content.
 * @param {{ windows: object[] }} archive - the archive index.
 * @returns {object[]} one row per archived window, newest last.
 */
export function describeWindows(archive) {
  return archive.windows.map(window => ({
    window: window.window,
    items: window.items,
    evictedTokens: window.shadowedTokenCount,
    firstTime: window.firstTime,
    lastTime: window.lastTime,
    idRange: `${ITEM_ID_PREFIX}${window.window}${ITEM_ID_SEPARATOR}0`
      + ` … ${ITEM_ID_PREFIX}${window.window}${ITEM_ID_SEPARATOR}${Math.max(0, window.items - 1)}`,
  }))
}

/**
 * Find a literal, case-sensitive substring across archived items.
 *
 * Case-sensitive matching is deliberate: a model looking for `Context` should
 * not drown in every `context`.
 * @param {{ items: Map<string, object> }} archive - the archive index.
 * @param {string} query - the literal to find.
 * @param {number} limit - maximum hits to return.
 * @param {number} snippetChars - characters of context shown around each hit.
 * @returns {{ total: number, truncated: boolean, hits: object[] }} matching items.
 */
export function searchArchive(archive, query, limit, snippetChars) {
  /** @type {object[]} */
  const hits = []
  let total = 0
  for (const item of archive.items.values()) {
    const at = item.text.indexOf(query)
    if (at === -1) continue
    total += 1
    if (hits.length >= limit) continue
    const start = Math.max(0, at - snippetChars)
    const end = Math.min(item.text.length, at + query.length + snippetChars)
    hits.push({
      id: item.id,
      window: item.window,
      role: item.role,
      occurrences: item.text.split(query).length - 1,
      snippet: `${start > 0 ? '…' : ''}${item.text.slice(start, end)}${end < item.text.length ? '…' : ''}`,
    })
  }
  return { total, truncated: total > hits.length, hits }
}

/**
 * Read one archived item by its recall id.
 * @param {{ items: Map<string, object> }} archive - the archive index.
 * @param {string} id - a recall id such as `w1:2`.
 * @param {number} maxChars - characters of content returned.
 * @returns {{ found: false } | { found: true, id: string, window: number, role: string, truncated: boolean, text: string }} the item.
 */
export function readArchivedItem(archive, id, maxChars) {
  const item = archive.items.get(id)
  if (item === undefined) return { found: false }
  const truncated = item.text.length > maxChars
  return {
    found: true,
    id: item.id,
    window: item.window,
    role: item.role,
    truncated,
    text: truncated ? `${item.text.slice(0, maxChars)}…` : item.text,
  }
}

/**
 * Count completed rollovers, which is the ordinal of the current window minus one.
 * @param {object} session - the session to inspect.
 * @returns {number} the current window ordinal, starting at 1.
 */
export function currentWindowNumber(session) {
  let rollovers = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/summary') rollovers += 1
  }
  return rollovers + 1
}
