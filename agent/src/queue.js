/**
 * Kolejka lokalna agenta — serializuje dostęp do Ollama.
 * Jeden request na raz (GPU nie obsługuje równoległego inference).
 */

const queue = []
let processing = false

/**
 * Wstawia zadanie do kolejki i czeka na wynik.
 * @param {Function} task — async funkcja do wykonania
 * @returns {Promise} — wynik task()
 */
export function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    processNext()
  })
}

/**
 * Przetwarza następne zadanie.
 */
async function processNext() {
  if (processing || queue.length === 0) return

  processing = true
  const { task, resolve, reject } = queue.shift()

  try {
    const result = await task()
    resolve(result)
  } catch (err) {
    reject(err)
  } finally {
    processing = false
    setImmediate(processNext)
  }
}

/**
 * Długość kolejki.
 */
export function getQueueLength() {
  return queue.length + (processing ? 1 : 0)
}

/**
 * Czy kolejka jest pusta i nic nie jest przetwarzane.
 */
export function isIdle() {
  return queue.length === 0 && !processing
}
