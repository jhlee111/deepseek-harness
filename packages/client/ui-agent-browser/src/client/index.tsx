/**
 * Client half of the agent-browser plugin.
 *
 * Every session-scoped dock card polls the host half's per-session feedback
 * endpoint. When the user presses "Send → agent" in the injected toolbar, a
 * NEW feedback entry surfaces as a visible card in `conversation.input.dock` —
 * the strip directly above the chat composer. [Add to chat] drops the formatted
 * feedback into the composer draft (so you can add your own words) without
 * auto-submitting; [Dismiss] clears the card without sending.
 *
 * Server-side, each session mounts its own agent-browser row, so each session
 * owns a browser, a dev server, and a per-session feedback port (derived from
 * the session id). The dock card below polls ITS session's port (via the
 * `sessionId` the slot framework injects), so feedback never crosses sessions.
 */
import React, { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the conversation slot map ('conversation.input.dock') augments
// the slot registry, and the settings shell declares 'settings.section'.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LaunchSettingsSection } from './LaunchSettingsSection.tsx'
import { BASE_PORT, sessionUrl } from './session.ts'
import css from './FeedbackCard.module.css'

interface FeedbackEntry {
  ts: string
  url: string | null
  viewport: { width: number; height: number } | null
  screenshot: string | null
  picked: Record<string, unknown> | null
  drawings: unknown[]
  note: string
  source?: string
}

export const inject = ['slots']

function clean(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/** Shorten a cssPath() selector for the chat draft: drop the LiveView root
    container and keep only the deepest two path segments. */
function shortenSelector(selector: string): string {
  if (!selector) return selector
  const steps = selector.split(' > ')
  const first = steps[0] ?? ''
  const meaningful =
    steps.length > 1 && first.startsWith('div#phx-') ? steps.slice(1) : steps
  const tail = meaningful.length > 1 ? meaningful.slice(-2) : meaningful
  return tail.join(' > ')
}

/** Composer draft the card sends (the same facts the agent's browser_feedback sees). */
function formatFeedback(feedback: FeedbackEntry): string {
  const parts = ['\u{1F50E} Browser feedback']
  if (feedback.url) parts.push('URL: ' + feedback.url)
  if (feedback.viewport) {
    parts.push('viewport: ' + feedback.viewport.width + 'x' + feedback.viewport.height)
  }
  if (feedback.picked) {
    const picked = feedback.picked
    if (picked.selector) {
      parts.push('picked: ' + shortenSelector(String(picked.selector)) + ' <' + String(picked.tag ?? '') + '>')
    }
    if (picked.text) parts.push('text: "' + clean(String(picked.text)).slice(0, 200) + '"')
    if (picked.box) parts.push('box: ' + JSON.stringify(picked.box))
  }
  if (feedback.drawings && feedback.drawings.length > 0) {
    parts.push('drawings: ' + feedback.drawings.length + ' stroke(s)')
  }
  if (feedback.screenshot) parts.push('screenshot: ' + feedback.screenshot)
  return parts.join('\n')
}

/** The slot-injected share this card reads. The session standard kit supplies
    `sessionId`; the input kit supplies `inputActions`. */
interface FeedbackCardProps {
  sessionId: string
  inputActions?: {
    setDraft(text: string): void
    submit(): void
  }
}

function FeedbackCard({ sessionId, inputActions }: FeedbackCardProps) {
  const [feedback, setFeedback] = useState<FeedbackEntry | null>(null)
  const [thumbFailed, setThumbFailed] = useState(false)

  // Poll this session's feedback endpoint. `lastSeen` lives in the effect
  // closure so a dismissal of the card (setFeedback(null)) does not re-show
  // the same entry on the next tick.
  useEffect(() => {
    let lastSeen: string | null = null
    const feedbackUrl = sessionUrl(BASE_PORT, sessionId, '/feedback')
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(feedbackUrl)
        if (!response.ok) return
        const data = (await response.json()) as { feedback?: FeedbackEntry[] }
        // Show only user-initiated toolbar feedback. Agent-initiated captures
        // go straight into the agent's context (browser_capture tool result),
        // so they must not surface a waiting card here.
        const latest = data.feedback?.find(entry => entry.source !== 'agent')
        if (latest === undefined || latest.ts === undefined) return
        const key = String(latest.ts)
        if (lastSeen === null) { lastSeen = key; return }
        if (key !== lastSeen) {
          lastSeen = key
          setFeedback(latest)
        }
      } catch {
        // Host half not up yet — keep polling.
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1000)
    return () => window.clearInterval(timer)
  }, [sessionId])

  if (feedback === null) return null

  const pickedLine = feedback.picked?.selector
    ? `picked: ${shortenSelector(String(feedback.picked.selector))}`
    : feedback.url
      ? `URL: ${feedback.url}`
      : null

  const send = (): void => {
    if (inputActions === undefined || feedback === null) return
    // Drop the formatted feedback into the composer as a draft, but do NOT
    // auto-submit — the user can add their own words and send when ready.
    inputActions.setDraft(formatFeedback(feedback))
    setFeedback(null)
  }

  return (
    <div className={css.dock} data-agent-browser-feedback="">
      <div className={css.card}>
        {feedback.screenshot && !thumbFailed && !feedback.screenshot.startsWith('error:') && (
          <img
            className={css.thumb}
            src={sessionUrl(BASE_PORT, sessionId, `/${feedback.screenshot}`)}
            alt="Browser screenshot"
            loading="lazy"
            onError={() => { setThumbFailed(true) }}
          />
        )}
        <div className={css.body}>
          <div className={css.head}>
            <span className={css.lead} aria-hidden><IconSearchOutline16 /></span>
            <span className={css.title}>Browser feedback</span>
            {feedback.url && <span className={css.meta}>{feedback.url}</span>}
          </div>
          {pickedLine && <p className={css.detail}>{pickedLine}</p>}
        </div>
        <div className={css.actions}>
          <button
            type="button"
            className={css.dismiss}
            aria-label="Dismiss feedback"
            title="Dismiss"
            onClick={() => { setFeedback(null) }}
          >
            <IconCloseOutline16 />
          </button>
          <button
            type="button"
            className={css.send}
            disabled={inputActions === undefined}
            onClick={send}
          >
            Add to chat
          </button>
        </div>
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'agent-browser-bridge', order: 5 },
      (props: FeedbackCardProps) => React.createElement(FeedbackCard, props),
    ),
  )

  // Launch settings page in the harness Settings panel (always visible).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'agent-browser', order: 20, label: () => 'Agent Browser' },
      props => React.createElement(LaunchSettingsSection, props),
    ),
  )
}
