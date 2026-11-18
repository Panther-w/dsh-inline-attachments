import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rewriteMessage } from '../host.js'

const image = (id) => ({ type: 'image', attachment: { attachmentId: id } })
const file = (id) => ({ type: 'file', attachment: { attachmentId: id } })
const text = (value) => ({ type: 'text', text: value })
const userMessage = (content) => ({ id: 'm1', source: { kind: 'user' }, content })
const kinds = (content) => content.map((block) => (block.type === 'text' ? `text:${block.text}` : block.type))

/** Invisible marker: U+2063 + N × U+200B + U+2063. */
const stamp = (index) => `\u2063${'\u200B'.repeat(index)}\u2063`

test('interleaves two images at their markers', () => {
  const rewritten = rewriteMessage(userMessage([
    image('a'), image('b'),
    text(`前${stamp(1)}中${stamp(2)}后`),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['text:前', 'image', 'text:中', 'image', 'text:后'])
  assert.equal(rewritten.content[1].attachment.attachmentId, 'a')
  assert.equal(rewritten.content[3].attachment.attachmentId, 'b')
})

test('supports file attachments in the same order', () => {
  const rewritten = rewriteMessage(userMessage([
    file('f1'), image('a'), text(`看${stamp(1)}和${stamp(2)}`),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['text:看', 'file', 'text:和', 'image'])
})

test('drops zero and out-of-range markers without touching the text', () => {
  const rewritten = rewriteMessage(userMessage([
    image('a'), text(`甲${stamp(0)}乙${stamp(9)}丙`),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['text:甲乙丙', 'image'])
})

test('leaves a message without markers identical', () => {
  const message = userMessage([image('a'), text('普通正文')])
  assert.equal(rewriteMessage(message), message)
})

test('appends attachments no marker referenced', () => {
  const rewritten = rewriteMessage(userMessage([
    image('a'), image('b'), text(`只有${stamp(2)}`),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['text:只有', 'image', 'image'])
  assert.equal(rewritten.content[1].attachment.attachmentId, 'b')
  assert.equal(rewritten.content[2].attachment.attachmentId, 'a')
})

test('ignores non-user and runtime-context messages', () => {
  const assistant = { id: 'm2', source: { kind: 'assistant' }, content: [text(stamp(1))] }
  const runtime = { id: 'm3', source: { kind: 'runtime-context' }, content: [text(stamp(1))] }
  assert.equal(rewriteMessage(assistant), assistant)
  assert.equal(rewriteMessage(runtime), runtime)
})

test('freezes the rewritten message and its content', () => {
  const rewritten = rewriteMessage(userMessage([image('a'), text(stamp(1))]))
  assert.ok(Object.isFrozen(rewritten))
  assert.ok(Object.isFrozen(rewritten.content))
  assert.ok(Object.isFrozen(rewritten.content[0]))
})

test('strips markers even when the message carries no attachment', () => {
  const rewritten = rewriteMessage(userMessage([text(`只剩${stamp(1)}文字`)]))
  assert.deepEqual(kinds(rewritten.content), ['text:只剩文字'])
  assert.ok(Object.isFrozen(rewritten))
})

test('interleaves across multiple text blocks', () => {
  const rewritten = rewriteMessage(userMessage([
    image('a'), text(`A${stamp(1)}`), text('B'),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['text:A', 'image', 'text:B'])
})

test('a duplicated marker inserts the attachment once', () => {
  const rewritten = rewriteMessage(userMessage([
    image('a'), text(`${stamp(1)}${stamp(1)}`),
  ]))
  assert.deepEqual(kinds(rewritten.content), ['image'])
})
