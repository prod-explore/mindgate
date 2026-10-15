import test from 'node:test'
import assert from 'node:assert/strict'
import { describeState, tasks } from '../src/state.js'

test('counts tasks in the singular and the plural', () => {
  assert.equal(tasks(1), '1 task')
  for (const n of [0, 2, 5, 11, 21, 100]) assert.equal(tasks(n), `${n} tasks`)
})

test('an idle agent is green and says what is in memory', () => {
  const s = describeState({ status: 'ok', busy: 0, models: [] })
  assert.equal(s.icon, 'green')
  assert.equal(s.title, 'ready')
  assert.match(s.detail, /Nothing is loaded/)
  assert.match(describeState({ status: 'ok', busy: 0, models: ['qwen3:4b', { id: 'llama3.2:3b' }] }).detail, /qwen3:4b, llama3\.2:3b/)
})

test('a busy agent is yellow and counts its tasks', () => {
  const s = describeState({ status: 'ok', busy: 3, models: [] })
  assert.equal(s.icon, 'yellow')
  assert.equal(s.title, 'working (3 tasks)')
})

test('no answer is a grey "not answering", not an "error"', () => {
  const s = describeState({ status: 'offline', busy: 0 })
  assert.equal(s.icon, 'gray')
  assert.equal(s.title, 'agent is not answering')
})

test('401 is a red message about a mismatched secret, the most common mistake', () => {
  const s = describeState({ status: 'error', busy: 0, httpStatus: 401 })
  assert.equal(s.icon, 'red')
  assert.equal(s.title, 'agent rejected the secret')
  assert.match(s.detail, /tray\.yml/)
  assert.equal(describeState({ status: 'error', httpStatus: 500 }).detail, 'HTTP response 500')
})

test('before the first answer the tray guesses nothing', () => {
  assert.equal(describeState({ status: 'unknown' }).title, 'connecting to the agent…')
  assert.equal(describeState({}).icon, 'gray')
})

test('idle readings within the TTL are shared, and a failed reading means "active"', async () => {
  const { memoizeIdle } = await import('../src/idle.js')
  let t = 0
  let calls = 0
  let fail = false
  const idle = memoizeIdle(() => { calls++; if (fail) throw new Error('no display'); return 42 }, 1000, () => t)
  assert.equal(idle(), 42)
  assert.equal(idle(), 42)
  t = 999
  assert.equal(idle(), 42)
  assert.equal(calls, 1, 'one process for three callers')
  t = 1000
  fail = true
  assert.equal(idle(), 0, 'cannot tell → assume the user is there')
  assert.equal(calls, 2)
})
