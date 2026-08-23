/**
 * Session-scoped agent-browser identity helpers — host half.
 *
 * The agent-browser host row is mounted ONCE under a preset's standing scope,
 * so it has no per-session `ctx.agent`. All per-session state (browser, dev
 * child, launch settings, feedback) is therefore keyed by the SESSION ID the
 * request or tool call identifies. A session's on-disk artifacts live under a
 * session-scoped subdirectory (see {@link sessionSegment}) so two sessions
 * never clobber each other's launch settings or feedback.
 * @module @deepseek-ai/dsh-agent-browser/session
 */

/**
 * A filesystem-safe path segment for one session. The session id is already
 * safe enough in practice, but it is a wire string (e.g. a uuid), so strip
 * anything that could route outside a single segment.
 */
export function sessionSegment(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId === '') return '_global'
  return `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * Extract the `sessionId` query parameter from a request URL.
 * @param url - the raw request URL (may carry a query string).
 * @returns the session id, or an empty string when absent.
 */
export function sessionIdFromRequestUrl(url: string | undefined): string {
  if (url === undefined || url === '') return ''
  const queryStart = url.indexOf('?')
  if (queryStart < 0) return ''
  const params = new URLSearchParams(url.slice(queryStart + 1))
  return params.get('sessionId') ?? ''
}
