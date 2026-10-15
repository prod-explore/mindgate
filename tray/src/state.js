// Zamienia stan agenta na to, co widzi człowiek. Bez zależności, żeby dało się to przetestować bez trayu i bez Windowsa.

/** 1 zadanie, 2 zadania, 5 zadań */
export function zadania(n) {
  if (n === 1) return '1 zadanie'
  const last = n % 10
  const teens = n % 100 >= 12 && n % 100 <= 14
  return last >= 2 && last <= 4 && !teens ? `${n} zadania` : `${n} zadań`
}

function modelNames(models) {
  return (models || [])
    .map(m => (typeof m === 'string' ? m : m?.id || m?.name || ''))
    .filter(Boolean)
}

/**
 * @param {{status?: string, busy?: number, models?: unknown[], httpStatus?: number}} state stan z pollingu agenta
 * @returns {{icon: 'green'|'yellow'|'blue'|'red'|'gray', title: string, detail: string}}
 */
export function describeState(state) {
  const busy = state.busy || 0
  switch (state.status) {
    case 'offline':
      return { icon: 'gray', title: 'agent nie odpowiada', detail: 'Usługa MindGate Agent nie działa albo ma inny port' }
    case 'error':
      return state.httpStatus === 401
        ? { icon: 'red', title: 'agent odrzucił sekret', detail: 'Sekret w tray.yml jest inny niż w agent/.env' }
        : { icon: 'red', title: 'agent zwrócił błąd', detail: state.httpStatus ? `Odpowiedź HTTP ${state.httpStatus}` : '' }
    case 'degraded':
      return { icon: 'red', title: 'agent działa z problemami', detail: 'Szczegóły są w panelu huba' }
    case 'unknown':
    case undefined:
      return { icon: 'gray', title: 'łączę z agentem…', detail: '' }
    default: {
      const names = modelNames(state.models)
      const loaded = names.length ? `W pamięci: ${names.join(', ')}` : 'Nic nie jest załadowane do pamięci'
      return busy > 0
        ? { icon: 'yellow', title: `pracuje (${zadania(busy)})`, detail: loaded }
        : { icon: 'green', title: 'gotowy', detail: loaded }
    }
  }
}
