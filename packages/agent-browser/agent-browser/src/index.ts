/**
 * Agent Browser — host half.
 *
 * Launches a headed Chrome via puppeteer-core, injects the Agent Browser
 * toolbar into every document, exposes agent tools (`browser_launch`,
 * `browser_feedback`, `browser_capture`) and serves a local HTTP feedback
 * endpoint consumed by the client half.
 *
 * The row publishes no service (it only consumes `tools`), so it sits loose
 * in a preset safely.
 * @module @deepseek-ai/dsh-agent-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

function pushLog<T>(arr: T[], entry: T, max = 300): void {
  arr.push(entry)
  if (arr.length > max) arr.shift()
}

export function apply(ctx: Context, config: Config = {}): void {
  const chromePath = config.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME
  const port = Number(config.port || process.env.AGENT_BROWSER_PORT || 4600)
  const defaultUrl = config.defaultUrl || process.env.AGENT_BROWSER_URL || 'http://localhost:4000/todos'
  const feedbackDir = path.resolve(config.feedbackDir || process.env.AGENT_BROWSER_DIR || path.join(__dirname, '..', 'feedback'))
  const toolbarPath = path.resolve(config.toolbarPath || path.join(__dirname, '..', 'assets', 'toolbar.js'))

  const shotsDir = path.join(feedbackDir, 'shots')
  const feedbackFile = path.join(feedbackDir, 'feedback.jsonl')
  fs.mkdirSync(shotsDir, { recursive: true })

  let toolbarSource = ''
  try {
    toolbarSource = fs.readFileSync(toolbarPath, 'utf8')
  } catch (e) {
    console.error(`[agent-browser] cannot read toolbar asset: ${toolbarPath}`, e)
  }

  let browser: Browser | null = null
  let page: Page | null = null
  const consoleLog: { type: string; text: string }[] = []
  const networkLog: { phase: string; method: string; url: string; status?: number; type?: string }[] = []
  const feedbackLog: FeedbackEntry[] = []

  // ── launch settings (persisted across launches/browser restarts) ─────────
  interface LaunchSettings {
    defaultUrl: string
    viewport: { width: number; height: number }
    window: { width: number; height: number }
    devServer: { command: string; cwd: string; port: number }
  }

  const launchSettingsFile = path.join(feedbackDir, 'launch-settings.json')

  function loadLaunchSettings(): LaunchSettings {
    const fallback: LaunchSettings = {
      defaultUrl,
      viewport: { width: 1280, height: 800 },
      window: { width: 1280, height: 800 },
      devServer: { command: '', cwd: '', port: 0 },
    }
    try {
      const data = JSON.parse(fs.readFileSync(launchSettingsFile, 'utf8')) as Partial<LaunchSettings>
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

  const launchSettings = loadLaunchSettings()

  function saveLaunchSettings(): void {
    try {
      fs.writeFileSync(launchSettingsFile, JSON.stringify(launchSettings, null, 2))
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
  let devChild: ChildProcess | null = null

  function waitForPort(port: number, timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const attempt = (): void => {
        if (Date.now() > deadline) { resolve(false); return }
        const sock = connect({ host: '127.0.0.1', port })
        sock.once('connect', () => { sock.destroy(); resolve(true) })
        sock.once('error', () => { sock.destroy(); setTimeout(attempt, 500) })
      }
      attempt()
    })
  }

  /**
   * Start the configured dev server (if any) and wait until its port answers.
   * Skips when the port is already responding or the child is already tracking.
   * @returns true when the server is (or is now) reachable.
   */
  async function ensureDevServer(): Promise<boolean> {
    const dev = launchSettings.devServer
    if (!dev.command || dev.port <= 0) return false
    // Already answering → assume an external/manual server is running.
    if (await waitForPort(dev.port, 2000)) return true
    if (devChild !== null) return true
    try {
      devChild = spawn('bash', ['-lc', dev.command], {
        cwd: dev.cwd || process.cwd(),
        env: process.env,
        stdio: 'inherit',
      })
      devChild.once('exit', () => { devChild = null })
    } catch (e) {
      console.error('[agent-browser] dev server spawn failed:', e)
      return false
    }
    return waitForPort(dev.port, 30000)
  }

  function appendFeedback(obj: Omit<FeedbackEntry, 'ts'>): FeedbackEntry {
    const entry: FeedbackEntry = { ts: new Date().toISOString(), ...obj }
    feedbackLog.push(entry)
    try {
      fs.appendFileSync(feedbackFile, JSON.stringify(entry) + '\n')
    } catch (e) {
      console.error('[agent-browser] feedback append failed:', e)
    }
    return entry
  }

  async function handleBridge(cmd: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      switch (cmd) {
        case 'ping':
          return { ok: true, url: page ? page.url() : null, viewport: page ? page.viewport() : null }
        case 'setViewport': {
          if (!page) return { ok: false, error: 'browser not launched' }
          const width = Number(payload.width) || launchSettings.viewport.width
          const height = Number(payload.height) || launchSettings.viewport.height
          await page.setViewport({ width, height })
          await resizeWindow(page, width, height)
          launchSettings.viewport = { width, height }
          saveLaunchSettings()
          return { ok: true, viewport: page.viewport() }
        }
        case 'setWindowSize': {
          if (!page) return { ok: false, error: 'browser not launched' }
          const width = Number(payload.width) || launchSettings.window.width
          const height = Number(payload.height) || launchSettings.window.height
          await resizeWindow(page, width, height)
          launchSettings.window = { width, height }
          saveLaunchSettings()
          return { ok: true, window: { width, height } }
        }
        case 'navigate': {
          if (!page) return { ok: false, error: 'browser not launched' }
          const url = String(payload.url ?? '')
          if (url === '') return { ok: false, error: 'url is required' }
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => {
            console.log('[agent-browser] goto warn:', e)
          })
          return { ok: true, url: page.url() }
        }
        case 'evaluate': {
          if (!page) return { ok: false, error: 'browser not launched' }
          const code = String(payload.code ?? '')
          if (code === '') return { ok: false, error: 'code is required' }
          const result = await page.evaluate(src => (0, eval)(src), code)
          return { ok: true, result }
        }
        case 'getLaunchSettings':
          return { ok: true, settings: { ...launchSettings } }
        case 'setLaunchSettings': {
          if (typeof payload.defaultUrl === 'string' && payload.defaultUrl !== '') {
            launchSettings.defaultUrl = payload.defaultUrl
          }
          if (payload.viewport && typeof payload.viewport === 'object') {
            const v = payload.viewport as Record<string, unknown>
            const width = Number(v.width)
            const height = Number(v.height)
            if (width > 0 && height > 0) {
              launchSettings.viewport = { width, height }
              if (page) {
                await page.setViewport({ width, height })
                await resizeWindow(page, width, height)
              }
            }
          }
          if (payload.window && typeof payload.window === 'object') {
            const w = payload.window as Record<string, unknown>
            const width = Number(w.width)
            const height = Number(w.height)
            if (width > 0 && height > 0) {
              launchSettings.window = { width, height }
              if (page) await resizeWindow(page, width, height)
            }
          }
          if (payload.devServer && typeof payload.devServer === 'object') {
            const d = payload.devServer as Record<string, unknown>
            launchSettings.devServer = {
              command: typeof d.command === 'string' ? d.command : launchSettings.devServer.command,
              cwd: typeof d.cwd === 'string' ? d.cwd : launchSettings.devServer.cwd,
              port: Number(d.port) > 0 ? Number(d.port) : launchSettings.devServer.port,
            }
          }
          saveLaunchSettings()
          return { ok: true, settings: { ...launchSettings } }
        }
        case 'reload':
          if (!page) return { ok: false, error: 'browser not launched' }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
          return { ok: true, url: page.url() }
        case 'feedback': {
          if (!page) return { ok: false, error: 'browser not launched' }
          let shot: string | null = null
          try {
            const buf = await page.screenshot({ encoding: 'binary' })
            const shotName = `shot-${Date.now()}.png`
            fs.writeFileSync(path.join(shotsDir, shotName), buf)
            shot = path.join('shots', shotName)
          } catch (e) {
            shot = 'error:' + (e instanceof Error ? e.message : String(e))
          }
          const entry = appendFeedback({
            url: page.url(),
            viewport: page.viewport(),
            screenshot: shot,
            picked: payload.picked ?? null,
            drawings: Array.isArray(payload.drawings) ? payload.drawings : [],
            note: String(payload.note ?? ''),
          })
          return { ok: true, id: entry.ts }
        }
        default:
          return { ok: false, error: 'unknown command: ' + cmd }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function launchBrowser(url?: string, width?: number, height?: number): Promise<Page> {
    let targetUrl = url || launchSettings.defaultUrl
    const viewportWidth = width || launchSettings.viewport.width
    const viewportHeight = height || launchSettings.viewport.height
    const windowWidth = launchSettings.window.width
    const windowHeight = launchSettings.window.height
    // Auto-start the configured dev server and open its port when no explicit URL was given.
    const dev = launchSettings.devServer
    if (dev.command && dev.port > 0) {
      await ensureDevServer()
      if (url === undefined || url === '') targetUrl = `http://127.0.0.1:${dev.port}`
    }
    if (browser && page) {
      if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
      }
      return page
    }
    browser = await puppeteer.launch({
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
    page = await browser.newPage()
    await page.setViewport({ width: viewportWidth, height: viewportHeight })
    await page.exposeFunction('__agentBridge', handleBridge)
    await page.evaluateOnNewDocument(toolbarSource)
    const interesting = new Set(['xhr', 'fetch', 'websocket', 'document', 'script', 'stylesheet'])
    page.on('console', msg => pushLog(consoleLog, { type: msg.type(), text: msg.text() }))
    page.on('request', (req) => {
      if (req.isNavigationRequest() || interesting.has(req.resourceType())) {
        pushLog(networkLog, { phase: 'request', method: req.method(), url: req.url(), type: req.resourceType() })
      }
    })
    page.on('response', (res) => {
      const req = res.request()
      if (req.isNavigationRequest() || interesting.has(req.resourceType())) {
        pushLog(networkLog, { phase: 'response', method: req.method(), url: res.url(), status: res.status(), type: req.resourceType() })
      }
    })
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => {
      console.log('[agent-browser] goto warn:', e)
    })
    return page
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'GET' && req.url?.startsWith('/feedback')) {
      res.end(JSON.stringify({
        feedback: feedbackLog.slice().reverse(),
        console: consoleLog.slice(),
        network: networkLog.slice(),
      }, null, 2))
      return
    }
    if (req.method === 'GET' && req.url === '/launch-settings') {
      res.end(JSON.stringify({ ok: true, settings: { ...launchSettings } }))
      return
    }
    if (req.method === 'POST' && req.url === '/launch-settings') {
      const result = await handleBridge('setLaunchSettings', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'POST' && req.url === '/navigate') {
      const result = await handleBridge('navigate', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'POST' && req.url === '/evaluate') {
      const result = await handleBridge('evaluate', await readJsonBody(req))
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/shots/')) {
      // Static thumbnail serving for the web GUI's feedback card.
      const name = path.basename(decodeURIComponent(req.url.slice('/shots/'.length)))
      const file = path.join(shotsDir, name)
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
    if (req.method === 'GET' && req.url === '/capture') {
      try {
        const entry = await handleBridge('feedback', { note: 'agent capture' })
        res.end(JSON.stringify(entry))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      }
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({
        ok: true,
        launched: page !== null,
        url: page ? page.url() : null,
        viewport: page ? page.viewport() : null,
      }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[agent-browser] feedback endpoint: http://127.0.0.1:${port}/feedback`)
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
    async execute(args: LaunchArgs): Promise<LaunchResult> {
      const url = args.url || launchSettings.defaultUrl
      const width = Number(args.width) || launchSettings.viewport.width
      const height = Number(args.height) || launchSettings.viewport.height
      const p = await launchBrowser(url, width, height)
      const vp = p.viewport() ?? { width: 0, height: 0 }
      return { ok: true, url: p.url(), viewport: { width: vp.width, height: vp.height } }
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
    async execute() {
      return {
        feedback: feedbackLog.slice().reverse() as unknown as JsonValue[],
        console: consoleLog.slice() as unknown as JsonValue[],
        network: networkLog.slice() as unknown as JsonValue[],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_capture',
    description: 'Capture the current browser state as a feedback entry (screenshot + picked element + drawings).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const entry = await handleBridge('feedback', { note: 'agent capture' })
      return { ok: entry.ok === true, id: String(entry.id ?? entry.error ?? '') }
    },
  }))

  ctx.effect(() => () => {
    server.close()
    if (devChild) devChild.kill()
    if (browser) browser.close().catch(() => {})
  })
}
