/**
 * Session-scoped agent-browser URL helpers — client side.
 *
 * The agent-browser host serves ONE HTTP endpoint (a single base port) and
 * dispatches to a session's browser/launch/feedback state by the `sessionId`
 * query parameter. These helpers build the session-addressed URLs the web
 * client uses, and the base port must match the host's default.
 *
 * Keep in sync with `packages/agent-browser/agent-browser/src/session.ts`.
 */

/** The deployment base feedback port; must match the host's default (4600). */
export const BASE_PORT = 4600

/** The base origin of the agent-browser host endpoint. */
export function baseOrigin(basePort: number): string {
  return `http://127.0.0.1:${basePort}`
}

/** The `?sessionId=…` query fragment, or an empty string for no session. */
export function sessionQuery(sessionId: string | undefined): string {
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
}

/**
 * Build a session-addressed agent-browser host URL.
 * @param basePort - the configured base feedback port.
 * @param sessionId - the session id (empty → the global state).
 * @param path - absolute path, e.g. `/feedback` or `/shots/shot-1.png`.
 * @returns the full URL carrying the session id.
 */
export function sessionUrl(basePort: number, sessionId: string | undefined, path: string): string {
  return `${baseOrigin(basePort)}${path}${sessionQuery(sessionId)}`
}
