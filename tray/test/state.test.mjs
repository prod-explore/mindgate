import test from 'node:test'
import assert from 'node:assert/strict'
import { describeState, zadania } from '../src/state.js'

test('polska odmiana: zadanie, zadania, zadań', () => {
  assert.equal(zadania(1), '1 zadanie')
  for (const n of [2, 3, 4, 22, 23, 104]) assert.equal(zadania(n), `${n} zadania`)
  for (const n of [0, 5, 11, 12, 13, 14, 15, 21, 100]) assert.equal(zadania(n), `${n} zadań`)
})

test('bezczynny agent jest zielony i mówi, co jest w pamięci', () => {
  const s = describeState({ status: 'ok', busy: 0, models: [] })
  assert.equal(s.icon, 'green')
  assert.equal(s.title, 'gotowy')
  assert.match(s.detail, /Nic nie jest załadowane/)
  assert.match(describeState({ status: 'ok', busy: 0, models: ['qwen3:4b', { id: 'llama3.2:3b' }] }).detail, /qwen3:4b, llama3\.2:3b/)
})

test('zajęty agent jest żółty i liczy zadania', () => {
  const s = describeState({ status: 'ok', busy: 3, models: [] })
  assert.equal(s.icon, 'yellow')
  assert.equal(s.title, 'pracuje (3 zadania)')
})

test('brak odpowiedzi to szary „nie odpowiada”, a nie „błąd”', () => {
  const s = describeState({ status: 'offline', busy: 0 })
  assert.equal(s.icon, 'gray')
  assert.equal(s.title, 'agent nie odpowiada')
})

test('401 to czerwony komunikat o niezgodnym sekrecie, bo to najczęstsza pomyłka', () => {
  const s = describeState({ status: 'error', busy: 0, httpStatus: 401 })
  assert.equal(s.icon, 'red')
  assert.equal(s.title, 'agent odrzucił sekret')
  assert.match(s.detail, /tray\.yml/)
  assert.equal(describeState({ status: 'error', httpStatus: 500 }).detail, 'Odpowiedź HTTP 500')
})

test('przed pierwszą odpowiedzią tray niczego nie zgaduje', () => {
  assert.equal(describeState({ status: 'unknown' }).title, 'łączę z agentem…')
  assert.equal(describeState({}).icon, 'gray')
})
