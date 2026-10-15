// Turns the agent's state into what a person sees. No dependencies, so it can be tested without the tray or Windows.

/** 1 task, 2 tasks */
export function tasks(n) {
  return n === 1 ? '1 task' : `${n} tasks`
}

function modelNames(models) {
  return (models || [])
    .map(m => (typeof m === 'string' ? m : m?.id || m?.name || ''))
    .filter(Boolean)
}

/**
 * @param {{status?: string, busy?: number, models?: unknown[], httpStatus?: number}} state the state from polling the agent
 * @returns {{icon: 'green'|'yellow'|'blue'|'red'|'gray', title: string, detail: string}}
 */
export function describeState(state) {
  const busy = state.busy || 0
  switch (state.status) {
    case 'offline':
      return { icon: 'gray', title: 'agent is not answering', detail: 'The MindGate Agent service is not running or uses another port' }
    case 'error':
      return state.httpStatus === 401
        ? { icon: 'red', title: 'agent rejected the secret', detail: 'The secret in tray.yml differs from the one in agent/.env' }
        : { icon: 'red', title: 'agent returned an error', detail: state.httpStatus ? `HTTP response ${state.httpStatus}` : '' }
    case 'degraded':
      return { icon: 'red', title: 'agent has problems', detail: 'Details are in the hub panel' }
    case 'unknown':
    case undefined:
      return { icon: 'gray', title: 'connecting to the agent…', detail: '' }
    default: {
      const names = modelNames(state.models)
      const loaded = names.length ? `In memory: ${names.join(', ')}` : 'Nothing is loaded into memory'
      return busy > 0
        ? { icon: 'yellow', title: `working (${tasks(busy)})`, detail: loaded }
        : { icon: 'green', title: 'ready', detail: loaded }
    }
  }
}
