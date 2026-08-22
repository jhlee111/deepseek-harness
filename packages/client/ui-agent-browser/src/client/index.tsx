/**
 * Client half of the agent-browser plugin.
 *
 * Polls the host half's local feedback endpoint. When the user presses
 * "Send → agent" in the injected toolbar, a NEW feedback entry surfaces as a
 * visible card in `conversation.input.dock` — the strip directly above the
 * chat composer. [Send to agent] hands the formatted feedback to the composer
 * and submits it; [Dismiss] clears the card without sending.
 *
 * The pending card is a single browser-page fact (module-level store shared
 * by every dock mount), updated by the one poller started in `apply`.
 */
import React, { useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: timer helpers (ctx.interval) and the conversation slot map
// ('conversation.input.dock') augment the context/slot registries.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Pull the settings slot registry type so 'settings.section' is a valid slot key.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LaunchSettingsSection } from './LaunchSettingsSection.tsx'
import css from './FeedbackCard.module.css'

const FEEDBACK_ORIGIN = 'http://127.0.0.1:4600'
const FEEDBACK_URL = `${FEEDBACK_ORIGIN}/feedback`

interface FeedbackEntry {
  ts: string
  url: string | null
  viewport: { width: number; height: number } | null
  screenshot: string | null
  picked: Record<string, unknown> | null
  drawings: unknown[]
  note: string
}

export const inject = ['slots', 'timer']

// One pending feedback per browser page (not per session): a module-level
// store read through useSyncExternalStore so every mounted dock card and the
// single poller agree on the same value.
let pending: FeedbackEntry | null = null
const listeners = new Set<() => void>()

function setPending(next: FeedbackEntry | null): void {
  pending = next
  for (const listener of listeners) listener()
}

function subscribePending(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

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

/** The dock-slot face handed to this card through the session standard kit. */
interface DockProps {
  inputActions?: {
    setDraft(text: string): void
    submit(): void
  }
}

function FeedbackCard({ inputActions }: DockProps) {
  const feedback = useSyncExternalStore(subscribePending, () => pending)
  const [sending, setSending] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)

  if (feedback === null) return null

  const pickedLine = feedback.picked?.selector
    ? `picked: ${shortenSelector(String(feedback.picked.selector))}`
    : feedback.url
      ? `URL: ${feedback.url}`
      : null

  const send = (): void => {
    if (inputActions === undefined || sending) return
    setSending(true)
    inputActions.setDraft(formatFeedback(feedback))
    inputActions.submit()
    setPending(null)
  }

  return (
    <div className={css.dock} data-agent-browser-feedback="">
      <div className={css.card}>
        {feedback.screenshot && !thumbFailed && !feedback.screenshot.startsWith('error:') && (
          <img
            className={css.thumb}
            src={`${FEEDBACK_ORIGIN}/${feedback.screenshot}`}
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
            onClick={() => { setPending(null) }}
          >
            <IconCloseOutline16 />
          </button>
          <button
            type="button"
            className={css.send}
            disabled={sending || inputActions === undefined}
            onClick={send}
          >
            Send to agent
          </button>
        </div>
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  let lastSeen: string | null = null

  const poll = async (): Promise<void> => {
    try {
      const response = await fetch(FEEDBACK_URL)
      if (!response.ok) return
      const data = (await response.json()) as { feedback?: FeedbackEntry[] }
      const latest = data.feedback?.[0]
      if (latest === undefined || latest.ts === undefined) return
      const key = String(latest.ts)
      // First poll only records the baseline; a card appears for entries
      // that arrive after this page loaded.
      if (lastSeen === null) { lastSeen = key; return }
      if (key !== lastSeen) {
        lastSeen = key
        setPending(latest)
      }
    } catch {
      // Host half not up yet — keep polling.
    }
  }

  ctx.effect(() => {
    void poll()
    const stop = ctx.interval(poll, 1000)
    return () => { stop() }
  })

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'agent-browser-bridge', order: 5 },
      (props: DockProps) => React.createElement(FeedbackCard, props),
    ),
  )

  // Launch settings page in the harness Settings panel (always visible).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'agent-browser', order: 20, label: () => 'Agent Browser' },
      (props: { close?: () => void }) => React.createElement(LaunchSettingsSection, props),
    ),
  )
}
