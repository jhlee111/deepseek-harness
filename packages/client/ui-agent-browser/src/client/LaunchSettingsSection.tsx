/**
 * Agent Browser launch settings section (harness GUI Settings).
 *
 * A self-contained form that reads and writes the agent-browser host's launch
 * settings over its local HTTP endpoint: default launch URL, initial viewport
 * size, and OS window size. No provider/model dependency — it owns its own
 * fetch and local state, so it renders whenever the Settings panel opens.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import css from './LaunchSettingsSection.module.css'

const HOST_ORIGIN = 'http://127.0.0.1:4600'

interface LaunchSettings {
  defaultUrl: string
  viewport: { width: number; height: number }
  window: { width: number; height: number }
  devServer: { command: string; cwd: string; port: number }
}

export interface LaunchSettingsSectionProps {
  /** Close the settings panel (owner share); optional for this section. */
  close?: () => void
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className={css.row}>
      <label className={css.label}>{props.label}</label>
      <div className={css.control}>{props.children}</div>
    </div>
  )
}

export function LaunchSettingsSection(_props: LaunchSettingsSectionProps) {
  const [settings, setSettings] = useState<LaunchSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${HOST_ORIGIN}/launch-settings`)
      .then(response => response.json())
      .then((data) => {
        if (!alive) return
        if (data && data.ok && data.settings) {
          setSettings(data.settings as LaunchSettings)
        } else {
          setMessage('Launch settings unavailable')
        }
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setMessage('agent-browser host not reachable')
        setLoading(false)
      })
    return () => { alive = false }
  }, [])

  if (loading) return <p className={css.state}>Loading launch settings…</p>
  if (settings === null) return <p className={css.state}>{message ?? 'Launch settings unavailable'}</p>

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
      const response = await fetch(`${HOST_ORIGIN}/launch-settings`, {
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
        Applies on the next browser launch. The dev server command runs in the working directory
        (environment injected by the command, e.g. envrun) and the browser waits for the port
        before opening.
      </p>
    </div>
  )
}
