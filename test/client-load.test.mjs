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

test('client.js loads, registers the overlay entry and the trigger source', async () => {
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

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'conversation.input.overlay')
  assert.equal(registrations[0].spec.spec.id, 'inline-attachments')
  assert.equal(typeof registrations[0].spec.component, 'function')

  assert.ok(source, 'source registered')
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'inline-attachments')
  assert.equal(typeof source.codec.serialize, 'function')
  assert.equal(typeof source.openReference, 'function')

  /* Empty registry: an unknown chip serializes to the zero marker. */
  assert.equal(await source.codec.serialize(JSON.stringify({ s: 's', a: 'a' })), '［附件已移除］')
  assert.equal(source.codec.clipboardText('not-json'), '@附件')
})
