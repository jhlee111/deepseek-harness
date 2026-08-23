/**
 * Agent Browser — host half.
 *
 * Launches a headed Chrome via puppeteer-core, injects the Agent Browser
 * toolbar into every document, exposes agent tools (`browser_launch`,
 * `browser_launch_settings`, `browser_feedback`, `browser_capture`) and serves
 * a local HTTP feedback endpoint consumed by the client half.
 *
 * The row is mounted ONCE under a preset's standing scope, so it holds no
 * per-session context. All session-scoped state — one browser, one dev-server
 * child, one launch-settings object, one feedback log — is keyed by the SESSION
 * ID a tool call or HTTP request identifies. Each session therefore owns an
 * independent browser (and dev-server port), so multiple sessions in the same
 * process never collide on launch settings or a feedback port.
 *
 * The row publishes no service (it only consumes `tools`), so it sits loose
 * in a preset safely.
 * @module @deepseek-ai/dsh-agent-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import fs from 'node:fs'
import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import type { Browser, Page, Viewport } from 'puppeteer-core'
import { sessionIdFromRequestUrl, sessionSegment } from './session.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const name = 'agent-browser'

export const inject = ['tools']

export interface Config {
  chromePath?: string
  port?: number
  defaultUrl?: string
  feedbackDir?: string
  toolbarPath?: string
}

export const Config: z<Config> = z.object({
  chromePath: z.string().default(''),
  port: z.number().default(4600),
  defaultUrl: z.string().default('http://localhost:4000/todos'),
  feedbackDir: z.string().default(''),
  toolbarPath: z.string().default(''),
})

const DEFAULT_CHROME =
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : ''

interface FeedbackEntry {
  ts: string
  url: string
  viewport: Viewport | null
  screenshot: string | null
  picked: unknown
  drawings: unknown[]
  note: string
  /** 'toolbar' = user-initiated (surfaces a card); 'agent' = tool-driven (agent context, no card). */
  source: 'toolbar' | 'agent'
}

interface LaunchArgs {
  url?: string
  width?: number
  height?: number
}

interface LaunchResult {
  ok: boolean
  url: string
  viewport: { width: number; height: number }
}

interface LaunchSettingsArgs {
  action?: string
  defaultUrl?: string
  viewport?: { width?: number; height?: number }
  window?: { width?: number; height?: number }
  devServer?: { command?: string; cwd?: string; port?: number }
}

interface LaunchSettings {
  defaultUrl: string
  viewport: { width: number; height: number }
  window: { width: number; height: number }
  devServer: { command: string; cwd: string; port: number }
}

interface SessionState {
  sessionId: string
  browser: Browser | null
  page: Page | null
  devChild: ChildProcess | null
  launchSettings: LaunchSettings
  feedbackLog: FeedbackEntry[]
  consoleLog: { type: string; text: string }[]
  networkLog: { phase: string; method: string; url: string; status?: number; type?: string }[]
  feedbackDir: string
  shotsDir: string
  feedbackFile: string
  launchSettingsFile: string
}

function pushLog<T>(arr: T[], entry: T, max = 300): void {
  arr.push(entry)
  if (arr.length > max) arr.shift()
}

export function apply(ctx: Context, config: Config = {}): void {
  const chromePath = config.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME
  const port = Number(config.port || process.env.AGENT_BROWSER_PORT || 4600)
  const defaultUrl = config.defaultUrl || process.env.AGENT_BROWSER_URL || 'http://localhost:4000/todos'
  const baseFeedbackDir = path.resolve(
    config.feedbackDir || process.env.AGENT_BROWSER_DIR || path.join(__dirname, '..', 'feedback'),
  )
  const toolbarPath = path.resolve(config.toolbarPath || path.join(__dirname, '..', 'assets', 'toolbar.js'))

  let toolbarSource = ''
  try {
    toolbarSource = fs.readFileSync(toolbarPath, 'utf8')
  } catch (e) {
    console.error(`[agent-browser] cannot read toolbar asset: ${toolbarPath}`, e)
  }

  // ── per-session state (this row is a single instance; sessions key the map) ─
  const states = new Map<string, SessionState>()

  function defaultLaunchSettings(): LaunchSettings {
    return {
      defaultUrl,
      viewport: { width: 1280, height: 800 },
      window: { width: 1280, height: 800 },
      devServer: { command: '', cwd: '', port: 0 },
    }
  }

  function loadLaunchSettings(file: string): LaunchSettings {
    const fallback = defaultLaunchSettings()
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LaunchSettings>
      return {
        defaultUrl: typeof data.defaultUrl === 'string' && data.defaultUrl !== ''
          ? data.defaultUrl
          : fallback.defaultUrl,
        viewport: {
          width: Number(data.viewport?.width) || fallback.viewport.width,
          height: Number(data.viewport?.height) || fallback.viewport.height,
        },
        window: {
          width: Number(data.window?.width) || fallback.window.width,
          height: Number(data.window?.height) || fallback.window.height,
        },
        devServer: {
          command: typeof data.devServer?.command === 'string'
            ? data.devServer.command
            : fallback.devServer.command,
          cwd: typeof data.devServer?.cwd === 'string'
            ? data.devServer.cwd
            : fallback.devServer.cwd,
          port: Number(data.devServer?.port) > 0 ? Number(data.devServer?.port) : fallback.devServer.port,
        },
      }
    } catch {
      return fallback
    }
  }

  function createSessionState(sessionId: string): SessionState {
    const feedbackDir = path.resolve(baseFeedbackDir, sessionSegment(sessionId))
    const shotsDir = path.join(feedbackDir, 'shots')
    const feedbackFile = path.join(feedbackDir, 'feedback.jsonl')
    const launchSettingsFile = path.join(feedbackDir, 'launch-settings.json')
    fs.mkdirSync(shotsDir, { recursive: true })
    return {
      sessionId,
      browser: null,
      page: null,
      devChild: null,
      launchSettings: loadLaunchSettings(launchSettingsFile),
      feedbackLog: [],
      consoleLog: [],
      networkLog: [],
      feedbackDir,
      shotsDir,
      feedbackFile,
      launchSettingsFile,
    }
  }

  /** Resolve (creating on demand) the state for one session id. */
  function stateFor(sessionId: string): SessionState {
    const key = sessionId || '_global'
    let state = states.get(key)
    if (state === undefined) {
      state = createSessionState(key)
      states.set(key, state)
    }
    return state
  }

  /** The calling session id of one tool execution (empty → the global state). */
  function sessionIdOf(exec: ToolRunContext): string {
    const id = exec.agent?.id
    return typeof id === 'string' ? id : ''
  }

  function saveLaunchSettings(state: SessionState): void {
    try {
      fs.writeFileSync(state.launchSettingsFile, JSON.stringify(state.launchSettings, null, 2))
    } catch (e) {
      console.error('[agent-browser] launch settings save failed:', e)
    }
  }

  async function resizeWindow(target: Page, width: number, height: number): Promise<void> {
    try {
      const cdp = await target.createCDPSession()
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
    } catch (e) {
      console.log('[agent-browser] window resize failed:', e)
    }
  }

  function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  // ── dev server bootstrapping ─────────────────────────────────────────────
  function waitForPort(targetPort: number, timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const attempt = (): void => {
        if (Date.now() > deadline) { resolve(false); return }
        const sock = connect({ host: '127.0.0.1', port: targetPort })
        sock.once('connect', () => { sock.destroy(); resolve(true) })
        sock.once('error', () => { sock.destroy(); setTimeout(attempt, 500) })
      }
      attempt()
    })
  }

  /**
   * Start the session's configured dev server (if any) and wait until its port
   * answers. Skips when the port already responds or the child is tracking.
   */
  async function ensureDevServer(state: SessionState): Promise<boolean> {
    const dev = state.launchSettings.devServer
    if (!dev.command || dev.port <= 0) return false
    if (await waitForPort(dev.port, 2000)) return true
    if (state.devChild !== null) return true
    try {
      state.devChild = spawn('bash', ['-lc', dev.command], {
        cwd: dev.cwd || process.cwd(),
        env: process.env,
        stdio: 'inherit',
      })
      state.devChild.once('exit', () => { state.devChild = null })
    } catch (e) {
      console.error('[agent-browser] dev server spawn failed:', e)
      return false
    }
    return waitForPort(dev.port, 30000)
  }

  function appendFeedback(state: SessionState, obj: Omit<FeedbackEntry, 'ts'>): FeedbackEntry {
    const entry: FeedbackEntry = { ts: new Date().toISOString(), ...obj }
    state.feedbackLog.push(entry)
    try {
      fs.appendFileSync(state.feedbackFile, JSON.stringify(entry) + '\n')
    } catch (e) {
      console.error('[agent-browser] feedback append failed:', e)
    }
    return entry
  }

  async function handleBridge(
    state: SessionState,
    cmd: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    try {
      switch (cmd) {
        case 'ping':
          return { ok: true, url: state.page ? state.page.url() : null, viewport: state.page ? state.page.viewport() : null }
        case 'setViewport': {
          if (!state.page) return { ok: false, error: 'browser not launched' }
          const width = Number(payload.width) || state.launchSettings.viewport.width
          const height = Number(payload.height) || state.launchSettings.viewport.height
          await state.page.setViewport({ width, height })
          await resizeWindow(state.page, width, height)
          state.launchSettings.viewport = { width, height }
          saveLaunchSettings(state)
          return { ok: true, viewport: state.page.viewport() }
        }
        case 'setWindowSize': {
          if (!state.page) return { ok: false, error: 'browser not launched' }
          const width = Number(payload.width) || state.launchSettings.window.width
          const height = Number(payload.height) || state.launchSettings.window.height
          await resizeWindow(state.page, width, height)
          state.launchSettings.window = { width, height }
          saveLaunchSettings(state)
          return { ok: true, window: { width, height } }
        }
        case 'navigate': {
          if (!state.page) return { ok: false, error: 'browser not launched' }
          const url = String(payload.url ?? '')
          if (url === '') return { ok: false, error: 'url is required' }
          await state.page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => {
            console.log('[agent-browser] goto warn:', e)
          })
          return { ok: true, url: state.page.url() }
        }
        case 'evaluate': {
          if (!state.page) return { ok: false, error: 'browser not launched' }
          const code = String(payload.code ?? '')
          if (code === '') return { ok: false, error: 'code is required' }
          const result = await state.page.evaluate(src => (0, eval)(src), code)
          return { ok: true, result }
        }
        case 'getLaunchSettings':
          return { ok: true, settings: { ...state.launchSettings } }
        case 'setLaunchSettings': {
          if (typeof payload.defaultUrl === 'string' && payload.defaultUrl !== '') {
            state.launchSettings.defaultUrl = payload.defaultUrl
          }
          if (payload.viewport && typeof payload.viewport === 'object') {
            const v = payload.viewport as Record<string, unknown>
            const width = Number(v.width)
            const height = Number(v.height)
            if (width > 0 && height > 0) {
              state.launchSettings.viewport = { width, height }
              if (state.page) {
                await state.page.setViewport({ width, height })
                await resizeWindow(state.page, width, height)
              }
            }
          }
          if (payload.window && typeof payload.window === 'object') {
            const w = payload.window as Record<string, unknown>
            const width = Number(w.width)
            const height = Number(w.height)
            if (width > 0 && height > 0) {
              state.launchSettings.window = { width, height }
              if (state.page) await resizeWindow(state.page, width, height)
            }
          }
          if (payload.devServer && typeof payload.devServer === 'object') {
            const d = payload.devServer as Record<string, unknown>
            state.launchSettings.devServer = {
              command: typeof d.command === 'string' ? d.command : state.launchSettings.devServer.command,
              cwd: typeof d.cwd === 'string' ? d.cwd : state.launchSettings.devServer.cwd,
              port: Number(d.port) > 0 ? Number(d.port) : state.launchSettings.devServer.port,
            }
          }
          saveLaunchSettings(state)
          return { ok: true, settings: { ...state.launchSettings } }
        }
        case 'reload':
          if (!state.page) return { ok: false, error: 'browser not launched' }
          await state.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
          return { ok: true, url: state.page.url() }
        case 'feedback': {
          if (!state.page) return { ok: false, error: 'browser not launched' }
          let shot: string | null = null
          let shotFile: string | null = null
          try {
            const buf = await state.page.screenshot({ encoding: 'binary' })
            const shotName = `shot-${Date.now()}.png`
            shotFile = path.join(state.shotsDir, shotName)
            fs.writeFileSync(shotFile, buf)
            shot = path.join('shots', shotName)
          } catch (e) {
            shot = 'error:' + (e instanceof Error ? e.message : String(e))
          }
          const entry = appendFeedback(state, {
            url: state.page.url(),
            viewport: state.page.viewport(),
            screenshot: shot,
            picked: payload.picked ?? null,
            drawings: Array.isArray(payload.drawings) ? payload.drawings : [],
            note: String(payload.note ?? ''),
            source: payload.source === 'agent' ? 'agent' : 'toolbar',
          })
          return { ok: true, id: entry.ts, ...entry, screenshotFile: shotFile }
        }
        default:
          return { ok: false, error: 'unknown command: ' + cmd }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function launchBrowser(state: SessionState, url?: string, width?: number, height?: number): Promise<Page> {
    let targetUrl = url || state.launchSettings.defaultUrl
    const viewportWidth = width || state.launchSettings.viewport.width
    const viewportHeight = height || state.launchSettings.viewport.height
    const windowWidth = state.launchSettings.window.width
    const windowHeight = state.launchSettings.window.height
    const dev = state.launchSettings.devServer
    if (dev.command && dev.port > 0) {
      await ensureDevServer(state)
      if (url === undefined || url === '') targetUrl = `http://127.0.0.1:${dev.port}`
    }
    if (state.browser && state.page) {
      if (targetUrl) {
        await state.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
      }
      return state.page
    }
    state.browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${windowWidth},${windowHeight}`,
        '--disable-features=Translate',
      ],
      defaultViewport: null,
      ...(chromePath ? { executablePath: chromePath } : {}),
    })
    state.page = await state.browser.newPage()
    await state.page.setViewport({ width: viewportWidth, height: viewportHeight })
    await state.page.exposeFunction('__agentBridge', (cmd: string, payload: Record<string, unknown>) =>
      handleBridge(state, cmd, payload))
    await state.page.evaluateOnNewDocument(toolbarSource)
    const interesting = new Set(['xhr', 'fetch', 'websocket', 'document', 'script', 'stylesheet'])
    state.page.on('console', msg => pushLog(state.consoleLog, { type: msg.type(), text: msg.text() }))
    state.page.on('request', (req) => {
      if (req.isNavigationRequest() || interesting.has(req.resourceType())) {
        pushLog(state.networkLog, { phase: 'request', method: req.method(), url: req.url(), type: req.resourceType() })
      }
    })
    state.page.on('response', (res) => {
      const req = res.request()
      if (req.isNavigationRequest() || interesting.has(req.resourceType())) {
        pushLog(state.networkLog, { phase: 'response', method: req.method(), url: res.url(), status: res.status(), type: req.resourceType() })
      }
    })
    await state.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => {
      console.log('[agent-browser] goto warn:', e)
    })
    return state.page
  }

  // ── single shared HTTP endpoint, dispatching per session id ───────────────
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    const sessionId = sessionIdFromRequestUrl(req.url)
    const state = stateFor(sessionId)
    if (req.method === 'GET' && req.url?.startsWith('/feedback')) {
      res.end(JSON.stringify({
        feedback: state.feedbackLog.slice().reverse(),
        console: state.consoleLog.slice(),
        network: state.networkLog.slice(),
      }, null, 2))
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/launch-settings')) {
      res.end(JSON.stringify({ ok: true, settings: { ...state.launchSettings } }))
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/launch-settings')) {
      const result = await handleBridge(state, 'setLaunchSettings', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/navigate')) {
      const result = await handleBridge(state, 'navigate', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/evaluate')) {
      const result = await handleBridge(state, 'evaluate', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/shots/')) {
      const clean = req.url.slice('/shots/'.length).split('?')[0] ?? ''
      const name = path.basename(decodeURIComponent(clean))
      const file = path.join(state.shotsDir, name)
      try {
        const buf = fs.readFileSync(file)
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'no-store')
        res.end(buf)
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'shot not found' }))
      }
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/capture')) {
      try {
        const entry = await handleBridge(state, 'feedback', { note: 'agent capture', source: 'agent' })
        res.end(JSON.stringify(entry))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      }
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      res.end(JSON.stringify({
        ok: true,
        launched: state.page !== null,
        url: state.page ? state.page.url() : null,
        viewport: state.page ? state.page.viewport() : null,
      }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[agent-browser] feedback endpoint: http://127.0.0.1:${port}/feedback?sessionId=<id>`)
  })

  ctx.tools.register(defineTool({
    name: 'browser_launch',
    description: 'Launch a headed Chrome window on a dev-server URL with the Agent Browser toolbar injected (Pick/Draw/viewport presets).',
    parameters: {
      url: { type: 'string', description: 'Dev server URL to open' },
      width: { type: 'number', description: 'Initial viewport width (default 1280)' },
      height: { type: 'number', description: 'Initial viewport height (default 800)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          viewport: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: LaunchArgs, exec: ToolRunContext): Promise<LaunchResult> {
      const state = stateFor(sessionIdOf(exec))
      const url = args.url || state.launchSettings.defaultUrl
      const width = Number(args.width) || state.launchSettings.viewport.width
      const height = Number(args.height) || state.launchSettings.viewport.height
      const p = await launchBrowser(state, url, width, height)
      const vp = p.viewport() ?? { width: 0, height: 0 }
      return { ok: true, url: p.url(), viewport: { width: vp.width, height: vp.height } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_launch_settings',
    description: 'Read or update THIS session\'s Agent Browser launch settings (default URL, viewport, window size, and the dev server the host auto-starts and opens). Inspect the project first (package.json, mix.exs, vite/next config, config/dev.exs …) to derive the dev server command, working directory, and port, then set them here. Settings are per-session and persist for this session only — another session\'s launch settings are unaffected. Use with browser_launch after setting devServer.',
    parameters: {
      action: { type: 'string', description: "'get' (default) returns current settings; 'set' applies the provided fields." },
      defaultUrl: { type: 'string', description: 'Default URL to open (the dev server URL).' },
      viewport: {
        type: 'object',
        additionalProperties: false,
        description: 'Browser viewport size.',
        properties: { width: { type: 'number' }, height: { type: 'number' } },
      },
      window: {
        type: 'object',
        additionalProperties: false,
        description: 'OS window size.',
        properties: { width: { type: 'number' }, height: { type: 'number' } },
      },
      devServer: {
        type: 'object',
        additionalProperties: false,
        description: 'Dev server the host runs, waits for, and opens: {command,cwd,port}.',
        properties: { command: { type: 'string' }, cwd: { type: 'string' }, port: { type: 'number' } },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          defaultUrl: { type: 'string', required: true },
          viewport: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true } },
          },
          window: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true } },
          },
          devServer: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              command: { type: 'string', required: true },
              cwd: { type: 'string', required: true },
              port: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: LaunchSettingsArgs, exec: ToolRunContext): Promise<LaunchSettings> {
      const state = stateFor(sessionIdOf(exec))
      if (args.action === 'set') {
        if (typeof args.defaultUrl === 'string' && args.defaultUrl !== '') {
          state.launchSettings.defaultUrl = args.defaultUrl
        }
        if (args.viewport) {
          const width = Number(args.viewport.width)
          const height = Number(args.viewport.height)
          if (width > 0 && height > 0) state.launchSettings.viewport = { width, height }
        }
        if (args.window) {
          const width = Number(args.window.width)
          const height = Number(args.window.height)
          if (width > 0 && height > 0) state.launchSettings.window = { width, height }
        }
        if (args.devServer) {
          if (typeof args.devServer.command === 'string') state.launchSettings.devServer.command = args.devServer.command
          if (typeof args.devServer.cwd === 'string') state.launchSettings.devServer.cwd = args.devServer.cwd
          if (Number(args.devServer.port) > 0) state.launchSettings.devServer.port = Number(args.devServer.port)
        }
        saveLaunchSettings(state)
      }
      return { ...state.launchSettings }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_feedback',
    description: 'Read feedback captured by the Agent Browser toolbar (picked elements, drawings, screenshots) plus captured console and network log tails.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          feedback: { type: 'array', required: true },
          console: { type: 'array', required: true },
          network: { type: 'array', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: unknown, exec: ToolRunContext): Promise<{ feedback: JsonValue[]; console: JsonValue[]; network: JsonValue[] }> {
      const state = stateFor(sessionIdOf(exec))
      return {
        feedback: state.feedbackLog.slice().reverse() as unknown as JsonValue[],
        console: state.consoleLog.slice() as unknown as JsonValue[],
        network: state.networkLog.slice() as unknown as JsonValue[],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_capture',
    description: 'Capture the current browser state (screenshot, url, viewport, picked element, drawings) and return it to the agent context. The capture is recorded but does not surface a user card — use browser_feedback to read the log if needed.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          viewport: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true } },
          },
          screenshot: { type: 'string', required: true },
          screenshotFile: { type: 'string', required: true },
          picked: { type: 'json', required: true },
          drawings: { type: 'array', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: unknown, exec: ToolRunContext): Promise<{
      ok: boolean
      id: string
      url: string
      viewport: { width: number; height: number }
      screenshot: string
      screenshotFile: string
      picked: JsonValue
      drawings: JsonValue[]
      note: string
    }> {
      const state = stateFor(sessionIdOf(exec))
      const entry = await handleBridge(state, 'feedback', { note: 'agent capture', source: 'agent' })
      const vp = entry.viewport as { width?: number; height?: number } | null
      return {
        ok: entry.ok === true,
        id: String(entry.id ?? entry.error ?? ''),
        url: String(entry.url ?? ''),
        viewport: { width: Number(vp?.width) || 0, height: Number(vp?.height) || 0 },
        screenshot: String(entry.screenshot ?? ''),
        screenshotFile: String(entry.screenshotFile ?? ''),
        picked: (entry.picked as JsonValue | null) ?? null,
        drawings: Array.isArray(entry.drawings) ? entry.drawings as JsonValue[] : [],
        note: String(entry.note ?? ''),
      }
    },
  }))

  ctx.effect(() => () => {
    server.close()
    for (const state of states.values()) {
      if (state.devChild) state.devChild.kill()
      if (state.browser) state.browser.close().catch(() => {})
    }
  })
}
