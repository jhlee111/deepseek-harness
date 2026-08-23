/**
 * Agent Browser launch settings section (harness GUI Settings).
 *
 * A self-contained form that reads and writes a session's agent-browser host
 * launch settings over that session's local HTTP endpoint: default launch URL,
 * initial viewport size, OS window size, and the dev server. Because launch
 * info is now scoped per session (one host row per session, per-session port),
 * this section carries a session selector: pick the session whose launch
 * settings you want to edit, and the form reads/writes that session's origin.
 *
 * No provider/model dependency — it owns its own fetch and local state, so it
 * renders whenever the Settings panel opens.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { BASE_PORT, sessionUrl } from './session.ts'
import css from './LaunchSettingsSection.module.css'

interface LaunchSettings {
  defaultUrl: string
  viewport: { width: number; height: number }
  window: { width: number; height: number }
  devServer: { command: string; cwd: string; port: number }
}

/** Props the settings slot supplies: the global standard kit plus the close handle. */
export interface LaunchSettingsSectionProps {
  close?: () => void
  useSessions: SnapshotSelectorHook<SessionListState>
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className={css.row}>
      <label className={css.label}>{props.label}</label>
      <div className={css.control}>{props.children}</div>
    </div>
  )
}

function sessionLabel(id: SessionId, sessions: SessionListState): string {
  const row = sessions.byId[id]
  const title = row?.title?.trim()
  const cwd = row?.cwd
  return [title, cwd].filter(Boolean).join(' — ') || id
}

export function LaunchSettingsSection({ useSessions }: LaunchSettingsSectionProps) {
  const sessions = useSessions(s => s)
  const [selectedId, setSelectedId] = useState<SessionId | undefined>(sessions.current ?? sessions.ids[0])
  const [settings, setSettings] = useState<LaunchSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Steer the selection to the current/first session once the list is ready,
  // and recover when the selected session leaves the list.
  useEffect(() => {
    if (selectedId === undefined || !sessions.ids.some(id => id === selectedId)) {
      const next = sessions.current ?? sessions.ids[0]
      if (next !== undefined) setSelectedId(next)
    }
  }, [sessions, selectedId])

  useEffect(() => {
    if (selectedId === undefined) {
      setSettings(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setMessage(null)
    const launchUrl = sessionUrl(BASE_PORT, selectedId, '/launch-settings')
    fetch(launchUrl)
      .then(response => response.json())
      .then((data) => {
        if (!alive) return
        if (data && data.ok && data.settings) {
          setSettings(data.settings as LaunchSettings)
        } else {
          setMessage('Launch settings unavailable')
        }
      })
      .catch(() => {
        if (!alive) return
        setMessage('agent-browser host not reachable')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [selectedId])

  if (selectedId === undefined) return <p className={css.state}>No session to edit.</p>
  if (loading) return <p className={css.state}>Loading launch settings…</p>
  if (settings === null) return <p className={css.state}>{message ?? 'Launch settings unavailable'}</p>

  const launchUrl = sessionUrl(BASE_PORT, selectedId, '/launch-settings')

  const update = (patch: Partial<LaunchSettings>): void => {
    setSettings(current => (current === null ? current : { ...current, ...patch }))
  }
  const updateViewport = (patch: Partial<LaunchSettings['viewport']>): void => {
    setSettings(current => (current === null ? current : { ...current, viewport: { ...current.viewport, ...patch } }))
  }
  const updateWindow = (patch: Partial<LaunchSettings['window']>): void => {
    setSettings(current => (current === null ? current : { ...current, window: { ...current.window, ...patch } }))
  }
  const updateDevServer = (patch: Partial<LaunchSettings['devServer']>): void => {
    setSettings(current => (current === null ? current : { ...current, devServer: { ...current.devServer, ...patch } }))
  }

  const save = async (): Promise<void> => {
    if (settings === null) return
    setSaving(true)
    setMessage(null)
    try {
      const response = await fetch(launchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = (await response.json()) as { ok?: boolean }
      setMessage(data.ok === true ? 'Saved \u2705' : 'Save failed')
    } catch {
      setMessage('Save failed \u2014 host not reachable')
    }
    setSaving(false)
  }

  return (
    <div className={css.panel}>
      <Field label="Session">
        <select
          className={css.input}
          value={selectedId}
          onChange={(event) => { setSelectedId(event.currentTarget.value as SessionId) }}
        >
          {sessions.ids.map(id => (
            <option key={id} value={id}>{sessionLabel(id, sessions)}</option>
          ))}
        </select>
      </Field>
      <Field label="Default URL">
        <input
          className={css.input}
          type="text"
          value={settings.defaultUrl}
          placeholder="http://…"
          onChange={(event) => { update({ defaultUrl: event.currentTarget.value }) }}
        />
      </Field>
      <Field label="Viewport">
        <input
          className={css.input}
          type="number"
          value={settings.viewport.width}
          aria-label="Viewport width"
          onChange={(event) => { updateViewport({ width: Number(event.currentTarget.value) || 0 }) }}
        />
        <span className={css.sep}>×</span>
        <input
          className={css.input}
          type="number"
          value={settings.viewport.height}
          aria-label="Viewport height"
          onChange={(event) => { updateViewport({ height: Number(event.currentTarget.value) || 0 }) }}
        />
      </Field>
      <Field label="Window size">
        <input
          className={css.input}
          type="number"
          value={settings.window.width}
          aria-label="Window width"
          onChange={(event) => { updateWindow({ width: Number(event.currentTarget.value) || 0 }) }}
        />
        <span className={css.sep}>×</span>
        <input
          className={css.input}
          type="number"
          value={settings.window.height}
          aria-label="Window height"
          onChange={(event) => { updateWindow({ height: Number(event.currentTarget.value) || 0 }) }}
        />
      </Field>
      <Field label="Dev server cmd">
        <input
          className={css.input}
          type="text"
          value={settings.devServer.command}
          placeholder="envrun .env iex -S mix phx.server"
          onChange={(event) => { updateDevServer({ command: event.currentTarget.value }) }}
        />
      </Field>
      <Field label="Working dir">
        <input
          className={css.input}
          type="text"
          value={settings.devServer.cwd}
          placeholder="/Users/johnlee/Dev/gs_net/.claude/worktrees/…"
          onChange={(event) => { updateDevServer({ cwd: event.currentTarget.value }) }}
        />
      </Field>
      <Field label="Port">
        <input
          className={css.input}
          type="number"
          value={settings.devServer.port}
          aria-label="Dev server port"
          onChange={(event) => { updateDevServer({ port: Number(event.currentTarget.value) || 0 }) }}
        />
      </Field>
      <div className={css.actions}>
        <button type="button" className={css.save} disabled={saving} onClick={() => { void save() }}>
          {saving ? 'Saving\u2026' : 'Save'}
        </button>
        {message !== null && <span className={css.message}>{message}</span>}
      </div>
      <p className={css.hint}>
        Applies to the selected session on its next browser launch. The dev server command
        runs in the working directory (environment injected by the command, e.g. envrun)
        and the browser waits for the port before opening.
      </p>
    </div>
  )
}
