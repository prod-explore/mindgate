/** An error the agent reports to the hub as a clean JSON answer instead of a 500. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }

  payload(): { error: { message: string; type: string; code: string } } {
    return { error: { message: this.message, type: this.status >= 500 ? 'server_error' : 'invalid_request_error', code: this.code } };
  }
}

export const isAgentError = (e: unknown): e is AgentError => e instanceof AgentError;
