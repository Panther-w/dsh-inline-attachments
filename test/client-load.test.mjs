import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal React face: the module factory only reads these at load/apply time. */
const react = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/** Minimal ReactDOM face for the lightbox portal. */
const reactDom = { createPortal: (node) => node }

test('client.js loads, registers overlay/restore slots and the trigger source', async () => {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry
      },
    },
  }
  await import('../client.js')

  assert.ok(loaded, 'module loader was called')
  assert.equal(loaded.id, 'dsh-inline-attachments')

  const mod = loaded.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${name}`)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'sessions', 'conversation', 'inputTriggers'])

  const registrations = []
  let source
  const ctx = {
    slots: {
      inject: (name, callback) => {
        registrations.push({ name, spec: callback() })
      },
      register: (spec, component) => ({ spec, component }),
    },
    inputTriggers: {
      registerSource: (value) => {
        source = value
        return () => {}
      },
    },
    effect: (fn) => fn(),
    sessions: { binding: () => undefined },
    conversation: { input: { for: () => undefined } },
  }

  mod.apply(ctx)

  const overlay = registrations.find((entry) => entry.name === 'conversation.input.overlay')
  const restore = registrations.find((entry) => entry.name === 'conversation.chat.user.before')
  assert.ok(overlay, 'overlay registered')
  assert.equal(overlay.spec.spec.id, 'inline-attachments')
  assert.equal(typeof overlay.spec.component, 'function')
  assert.ok(restore, 'restore action registered')
  assert.equal(restore.spec.spec.id, 'inline-attachments-restore')
  assert.equal(typeof restore.spec.spec.select, 'function')
  assert.equal(typeof restore.spec.component, 'function')

  assert.ok(source, 'source registered')
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'inline-attachments')
  assert.equal(typeof source.codec.serialize, 'function')
  assert.equal(typeof source.openReference, 'function')

  /* Empty registry: an unknown chip serializes to the zero marker. */
  assert.equal(await source.codec.serialize(JSON.stringify({ s: 's', a: 'a' })), '［附件已移除］')
  assert.equal(source.codec.clipboardText('not-json'), '@附件')
})
