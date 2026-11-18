import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

test('index.js registers one pre-step waterfall and rewrites enter decisions', async () => {
  let listener
  let eventName
  apply({
    on: (name, handler) => {
      eventName = name
      listener = handler
    },
  })

  assert.equal(eventName, 'agent/pre-step')
  assert.equal(typeof listener, 'function')

  const message = {
    id: 'm1',
    source: { kind: 'user' },
    content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'text', text: `前\u2063\u200B\u2063后` },
    ],
  }

  const decision = await listener({}, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(
    decision.messages[0].content.map((block) => (block.type === 'text' ? `text:${block.text}` : block.type)),
    ['text:前', 'image', 'text:后'],
  )
})

test('index.js leaves reject decisions untouched', async () => {
  let listener
  apply({ on: (_name, handler) => { listener = handler } })
  const reject = { kind: 'reject' }
  assert.equal(await listener({}, async () => reject), reject)
})
