import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rewriteMessage } from '../host.js'

/**
 * A tiny hook harness: the client component is rendered directly with fake
 * React hooks, so insertion timing, span collapsing, focus gating, two-way
 * attachment sync and codec output can be checked without a browser.
 */
let loaded
let blocker = null

test('prepare', async () => {
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  globalThis.document = {
    activeElement: { isContentEditable: true },
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => blocker,
    querySelectorAll: () => [],
  }
  await import('../client.js')
  assert.ok(loaded)
})

const attachments = [
  { id: 'a1', kind: 'image', file: { name: 'cat.png', size: 10 }, previewUrl: 'blob:cat' },
  { id: 'a2', kind: 'image', file: { name: 'dog.png', size: 10 }, previewUrl: 'blob:dog' },
  { id: 'a3', kind: 'file', file: { name: 'notes.pdf', size: 10 } },
  { id: 'a4', kind: 'image', file: { name: 'image.png', size: 10 }, previewUrl: 'blob:dup1' },
  { id: 'a5', kind: 'image', file: { name: 'image.png', size: 10 }, previewUrl: 'blob:dup2' },
  { id: 'a6', kind: 'image', file: { name: 'cat.png', size: 10 }, previewUrl: 'blob:cat2' },
  { id: 'a7', kind: 'image', file: { name: 'image.png', size: 10 }, previewUrl: 'blob:dup3' },
]

/** Build one independent component instance with a fake React and fake ctx. */
function harness() {
  const cells = new Map()
  let hookIndex = 0
  let effects = []
  let cleanups = []
  const ReactFace = {
    createElement: (type, props) => ({ type, props }),
    useState: (initial) => {
      const index = hookIndex++
      if (!cells.has(index)) cells.set(index, initial)
      return [cells.get(index), (value) => { cells.set(index, value) }]
    },
    useRef: (initial) => {
      const index = hookIndex++
      if (!cells.has(index)) cells.set(index, { current: initial })
      return cells.get(index)
    },
    useEffect: (fn) => {
      const index = hookIndex++
      effects[index] = fn
    },
    useCallback: (fn) => fn,
  }
  const mod = loaded.factory((name) => {
    if (name === 'react-dom') return { createPortal: (node) => node }
    if (name === 'react') return ReactFace
    throw new Error(`unexpected require: ${name}`)
  })

  const inserted = []
  const removed = []
  const added = []
  const snapshots = []
  const listeners = []
  const focused = []
  let component
  let source
  let live = { phase: 'plain', draft: '', draftRev: 3, attachmentIds: [], occurrences: [] }
  const ctx = {
    slots: {
      inject: (_name, callback) => { callback() },
      register: (_spec, value) => { component = value; return {} },
    },
    inputTriggers: { registerSource: (value) => { source = value; return () => {} } },
    effect: (fn) => fn(),
    sessions: { binding: () => ({ ctx: {} }) },
    conversation: {
      input: {
        for: () => ({
          insertReference: (reference, span) => { inserted.push({ reference, span }); return true },
          focus: () => { focused.push(1) },
          state: {
            getSnapshot: () => live,
            subscribe: (listener) => {
              listeners.push(listener)
              return () => {
                const index = listeners.indexOf(listener)
                if (index >= 0) listeners.splice(index, 1)
              }
            },
          },
        }),
      },
      resolveDraftAttachments: (ids) => attachments.filter((item) => ids.includes(item.id)),
    },
  }
  mod.apply(ctx)

  const inputActions = {
    captureInsertion: () => ({ start: 5, end: 9, draftRev: 3 }),
    removeAttachment: (id) => { removed.push(id) },
    addAttachments: (ids) => { added.push(...ids); return true },
    setDraft: (snapshot) => { snapshots.push(snapshot) },
  }

  const render = (state) => {
    live = state
    for (const cleanup of cleanups) {
      try { cleanup() } catch (error) { /* ignore */ }
    }
    cleanups = []
    hookIndex = 0
    effects = []
    component({ sessionId: 's1', useInput: (selector) => selector(state), inputActions })
    for (const effect of effects) {
      if (typeof effect === 'function') {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    }
  }

  return { inserted, removed, added, snapshots, focused, render, source, setLive: (state) => { live = state }, notify: () => { for (const listener of [...listeners]) listener() } }
}

const plain = { phase: 'plain', draft: '', draftRev: 3 }
const stateOf = (attachmentIds, occurrences = [], draft = '') => ({ ...plain, attachmentIds, occurrences, draft })
const occurrenceOf = (reference, offset = 0, length = 1) => ({
  source: 'inline-attachments', ref: reference, occurrenceId: 1, offset, length, clipboardText: '@image.png',
})

test('a new attachment inserts a collapsed chip at the retained caret, even when the editor is unfocused', () => {
  const h = harness()
  h.render(stateOf([]))
  globalThis.document.activeElement = { isContentEditable: false }
  h.render(stateOf(['a1']))
  assert.equal(h.inserted.length, 1)
  assert.deepEqual(h.inserted[0].span, { start: 9, end: 9, draftRev: 3 })
})

test('deleting a chip removes its attachment, undo restores it, and a rail deletion never adds it back', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  assert.equal(h.inserted.length, 1)
  assert.deepEqual(h.inserted[0].span, { start: 9, end: 9, draftRev: 3 })
  const refA = h.inserted[0].reference.ref
  assert.deepEqual(JSON.parse(refA), { s: 's1', a: 'a1' })
  assert.equal(h.inserted[0].reference.label, 'cat.png')

  const marker = h.source.codec.serialize(refA)
  return marker.then(async (value) => {
    assert.equal(value, '[图片1]' + '\u2063\u200B\u2063')

    // The codec must read the live input order, not a stale render registry.
    h.setLive(stateOf([]))
    assert.equal(await h.source.codec.serialize(refA), '［附件已移除］')
    h.render(stateOf(['a1']))
    const rewritten = rewriteMessage({
      id: 'm1',
      source: { kind: 'user' },
      content: [
        { type: 'image', attachment: { attachmentId: 'a1' } },
        { type: 'text', text: `前${value}后` },
      ],
    })
    assert.deepEqual(
      rewritten.content.map((block) => (block.type === 'text' ? `text:${block.text}` : block.type)),
      ['text:前 [图片1]', 'image', 'text: 后'],
    )

    // Confirm the chip was actually seen by the input state.
    const occA = occurrenceOf(refA, 1, 8)
    const draftA = 'A@cat.pngC'
    h.render(stateOf(['a1'], [occA], draftA))
    // Delete the chip while the attachment is still in the rail.
    h.render(stateOf(['a1'], [], ''))
    assert.deepEqual(h.removed, ['a1'])
    // Undo brings the chip back; the plugin re-adds the attachment.
    h.render(stateOf([], [occA], draftA))
    assert.deepEqual(h.added, ['a1'])

    // Insert a second chip, confirm both, then delete its attachment from the rail.
    h.render(stateOf(['a1', 'a2'], [occA], draftA))
    assert.equal(h.inserted.length, 2)
    const refB = h.inserted[1].reference.ref
    const occB = occurrenceOf(refB, 10, 8)
    const draftAB = 'A@cat.pngB@dog.png'
    h.render(stateOf(['a1', 'a2'], [occA, occB], draftAB))
    globalThis.document.activeElement = null
    h.render(stateOf(['a1'], [occA, occB], draftAB))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A rail deletion removes the chip through a draft rewrite, not by re-adding the attachment.
    assert.deepEqual(h.added, ['a1'])
    assert.equal(h.snapshots.length, 1)
    assert.equal(h.snapshots[0].text, 'A@cat.pngB')
    assert.equal(h.snapshots[0].references.length, 1)
    assert.equal(h.snapshots[0].references[0].ref, refA)
    assert.equal(h.snapshots[0].references[0].offset, 1)
    assert.equal(h.focused.length, 1)
  })
})


test('the live store subscription removes the attachment before the next render', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  const refA = h.inserted[0].reference.ref
  h.render(stateOf(['a1'], [occurrenceOf(refA, 1, 8)], 'A@cat.pngC'))
  // The input store publishes the chip deletion outside React.
  h.setLive(stateOf(['a1'], []))
  h.notify()
  assert.deepEqual(h.removed, ['a1'])
})

test('the live store subscription removes multiple attachments in one publish', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1', 'a2']))
  const refA = h.inserted[0].reference.ref
  const refB = h.inserted[1].reference.ref
  h.render(stateOf(['a1', 'a2'], [occurrenceOf(refA, 1, 8), occurrenceOf(refB, 10, 8)], 'A@cat.pngB@dog.png'))
  h.setLive(stateOf(['a1', 'a2'], []))
  h.notify()
  assert.deepEqual(h.removed, ['a1', 'a2'])
})

test('a quote or command in the draft blocks the rail-to-chip rewrite', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  const refA = h.inserted[0].reference.ref
  const occA = occurrenceOf(refA, 1, 8)
  h.render(stateOf(['a1'], [occA], 'A@cat.png'))
  blocker = {}
  h.render(stateOf([], [occA], 'A@cat.png'))
  assert.equal(h.snapshots.length, 0)
  blocker = null
  h.render(stateOf([], [occA], 'A@cat.png'))
  assert.equal(h.snapshots.length, 1)
  // A mid-text chip is now rewritten too (caret jumps to the end; documented).
  const h2 = harness()
  h2.render(stateOf([]))
  h2.render(stateOf(['a1']))
  const refB = h2.inserted[0].reference.ref
  const occB = occurrenceOf(refB, 1, 8)
  h2.render(stateOf(['a1'], [occB], 'A@cat.png尾'))
  h2.render(stateOf([], [occB], 'A@cat.png尾'))
  assert.equal(h2.snapshots.length, 1)
})


test('duplicate file names get a display suffix', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a4', 'a5']))
  assert.equal(h.inserted.length, 2)
  assert.equal(h.inserted[0].reference.label, 'image.png')
  assert.equal(h.inserted[1].reference.label, 'image.png (2)')
})


test('a carried chip uses the current session attachment order', async () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  const carried = JSON.stringify({ s: 'old-session', a: 'a1' })
  h.render(stateOf(['a1'], [occurrenceOf(carried, 1, 8)], 'A@cat.png'))
  assert.equal(await h.source.codec.serialize(carried), '[图片1]' + '\u2063\u200B\u2063')
})


test('a deleted chip does not reserve its label for the next same-named upload', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  const refA = h.inserted[0].reference.ref
  h.render(stateOf(['a1'], [occurrenceOf(refA, 1, 8)], 'A@cat.png'))
  h.render(stateOf(['a1'], [], ''))
  assert.deepEqual(h.removed, ['a1'])
  h.render(stateOf(['a6']))
  assert.equal(h.inserted[1].reference.label, 'cat.png')
})


test('a rail deletion before the chip is confirmed still removes the chip when it appears', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1']))
  const refA = h.inserted[0].reference.ref
  // Rail deletes the attachment before the chip occurrence reaches the input state.
  h.render(stateOf([]))
  h.render(stateOf([], [occurrenceOf(refA, 1, 8)], 'A@cat.png'))
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.snapshots[0].text, 'A')
})


test('deleting several rail attachments in one tick rewrites all chips once', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1', 'a2']))
  const refA = h.inserted[0].reference.ref
  const refB = h.inserted[1].reference.ref
  const occA = occurrenceOf(refA, 1, 8)
  const occB = occurrenceOf(refB, 10, 8)
  const draft = 'A@cat.pngB@dog.png'
  h.render(stateOf(['a1', 'a2'], [occA, occB], draft))
  h.render(stateOf([], [occA, occB], draft))
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.snapshots[0].text, 'AB')
  assert.equal(h.snapshots[0].references.length, 0)
})

test('deleting an earlier duplicate does not reuse its number', () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a4', 'a5']))
  const refA = h.inserted[0].reference.ref
  h.render(stateOf(['a4', 'a5'], [occurrenceOf(refA, 1, 8)], 'A@image.png'))
  h.render(stateOf(['a4', 'a5'], [], ''))
  assert.deepEqual(h.removed, ['a4'])
  h.render(stateOf(['a5', 'a7']))
  assert.equal(h.inserted[2].reference.label, 'image.png (3)')
})


test('clicking a file label opens or downloads the file', () => {
  const h = harness()
  let clicked = 0
  const anchor = { href: '', download: '', rel: '', click: () => { clicked += 1 }, remove: () => {} }
  const previousCreate = globalThis.document.createElement
  const previousBody = globalThis.document.body
  const previousCreateURL = URL.createObjectURL
  const previousRevokeURL = URL.revokeObjectURL
  globalThis.document.createElement = () => anchor
  globalThis.document.body = { appendChild: () => {} }
  URL.createObjectURL = () => 'blob:file'
  URL.revokeObjectURL = () => {}
  try {
    const ref = JSON.stringify({ s: 's1', a: 'a3' })
    assert.equal(h.source.openReference({ sessionId: 's1' }, { ref }), true)
    assert.equal(clicked, 1)
  } finally {
    globalThis.document.createElement = previousCreate
    globalThis.document.body = previousBody
    URL.createObjectURL = previousCreateURL
    URL.revokeObjectURL = previousRevokeURL
  }
})




test('a PDF label opens a window without also downloading', () => {
  const h = harness()
  let clicked = 0
  const anchor = { href: '', download: '', rel: '', click: () => { clicked += 1 }, remove: () => {} }
  const previousOpen = globalThis.window.open
  const previousCreate = globalThis.document.createElement
  const previousBody = globalThis.document.body
  const previousCreateURL = URL.createObjectURL
  const previousRevokeURL = URL.revokeObjectURL
  globalThis.window.open = () => ({ opener: {} })
  globalThis.document.createElement = () => anchor
  globalThis.document.body = { appendChild: () => {} }
  URL.createObjectURL = () => 'blob:pdf'
  URL.revokeObjectURL = () => {}
  try {
    const ref = JSON.stringify({ s: 's1', a: 'a3' })
    assert.equal(h.source.openReference({ sessionId: 's1' }, { ref }), true)
    assert.equal(clicked, 0)
  } finally {
    globalThis.window.open = previousOpen
    globalThis.document.createElement = previousCreate
    globalThis.document.body = previousBody
    URL.createObjectURL = previousCreateURL
    URL.revokeObjectURL = previousRevokeURL
  }
})

test('sent text uses [图片N]/[文件N] placeholders instead of @filename', async () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a1', 'a2']))
  const refA = h.inserted[0].reference.ref
  const refB = h.inserted[1].reference.ref
  const stamp = (n) => '\u2063' + '\u200B'.repeat(n) + '\u2063'
  assert.equal(await h.source.codec.serialize(refA), '[图片1]' + stamp(1))
  assert.equal(await h.source.codec.serialize(refB), '[图片2]' + stamp(2))
})

test('file attachments serialize as [文件N] placeholders', async () => {
  globalThis.document.activeElement = { isContentEditable: true }
  const h = harness()
  h.render(stateOf([]))
  h.render(stateOf(['a3']))
  const ref = h.inserted[0].reference.ref
  const stamp = '\u2063' + '\u200B' + '\u2063'
  assert.equal(await h.source.codec.serialize(ref), '[文件1]' + stamp)
})

test('a message that starts with an attachment gets no leading space', () => {
  const rewritten = rewriteMessage({
    id: 'm1',
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'a1' } }, { type: 'text', text: '[图片1]\u2063\u200B\u2063' }],
  })
  assert.equal(rewritten.content[0].text, '[图片1]', 'first block keeps no leading space')
})

test('a file mention between two images keeps placeholder order', () => {
  const rewritten = rewriteMessage({
    id: 'm1',
    source: { kind: 'user' },
    content: [
      { type: 'image', attachment: { attachmentId: 'a1' } },
      { type: 'file', attachment: { attachmentId: 'a3' } },
      { type: 'image', attachment: { attachmentId: 'a2' } },
      { type: 'text', text: '[图片1]\u2063\u200B\u2063[文件1]\u2063\u200B\u200B\u2063[图片2]\u2063\u200B\u200B\u200B\u2063' },
    ],
  })
  const kinds = rewritten.content.map((block) => (block.type === 'text' ? `text:${block.text}` : block.attachment.attachmentId))
  assert.deepEqual(kinds, ['text:[图片1]', 'a1', 'text: [文件1]', 'a3', 'text: [图片2]', 'a2'])
})
