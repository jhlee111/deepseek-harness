(function () {
  if (window.__agentToolbarInstalled) return
  window.__agentToolbarInstalled = true

  const state = { pick: false, draw: false, strokes: [], picked: null, collapsed: false }

  const CSS = [
    '#__agent_tb{position:fixed;z-index:2147483000;background:rgba(17,18,26,.96);color:#e5e7eb;font:12px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);overflow:hidden;user-select:none}',
    '#__agent_tb *{box-sizing:border-box}',
    '#__agent_tb .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:grab;background:linear-gradient(180deg,rgba(255,255,255,.06),transparent)}',
    '#__agent_tb .hd:active{cursor:grabbing}',
    '#__agent_tb .hd .grip{color:#6b7280;font-size:13px}',
    '#__agent_tb .hd b{color:#fff;font-size:12px;font-weight:600;flex:1;white-space:nowrap}',
    '#__agent_tb .hd .dims{color:#9ca3af;font-size:10px;white-space:nowrap}',
    '#__agent_tb .hd button{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:12px;padding:0 2px;line-height:1}',
    '#__agent_tb .hd button:hover{color:#fff}',
    '#__agent_tb .bd{padding:8px 10px 10px;display:flex;flex-direction:column;gap:7px;width:268px}',
    '#__agent_tb .sec{display:flex;align-items:center;gap:6px}',
    '#__agent_tb .lbl{color:#6b7280;font-size:9px;text-transform:uppercase;letter-spacing:.5px;width:52px;flex:none}',
    '#__agent_tb button{background:#2b2b38;color:#e5e7eb;border:1px solid #3a3a4a;border-radius:7px;padding:5px 8px;cursor:pointer;font-size:11px;font-family:inherit}',
    '#__agent_tb button:hover{background:#34343f}',
    '#__agent_tb button.on{background:#3b82f6;border-color:#3b82f6;color:#fff}',
    '#__agent_tb button.danger-on{background:#ef4444;border-color:#ef4444;color:#fff}',
    '#__agent_tb button.primary{background:#22c55e;border-color:#22c55e;color:#04150a;font-weight:600;flex:1}',
    '#__agent_tb select{background:#2b2b38;color:#e5e7eb;border:1px solid #3a3a4a;border-radius:7px;padding:4px 6px;font-size:11px;font-family:inherit;flex:1}',
    '#__agent_tb .tools{flex:1;display:flex;gap:6px}',
    '#__agent_tb .tools button{flex:1}',
    '#__agent_tb .status{color:#9ca3af;font-size:10px;border-top:1px solid rgba(255,255,255,.06);padding-top:6px;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#__agent_pick_hl{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,.15);border-radius:2px;display:none}',
    '#__agent_draw{position:fixed;inset:0;z-index:2147482998;pointer-events:none;touch-action:none}',
  ].join('\n')

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return ''
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      let part = node.tagName.toLowerCase()
      if (node.id) { part += '#' + node.id; parts.unshift(part); break }
      if (node.classList && node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  function init() {
    if (document.getElementById('__agent_tb')) return

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    // ---- panel ----
    const tb = document.createElement('div')
    tb.id = '__agent_tb'

    const hd = document.createElement('div')
    hd.className = 'hd'
    const grip = document.createElement('span')
    grip.className = 'grip'
    grip.textContent = '\u2807'
    const title = document.createElement('b')
    title.textContent = 'Agent Browser'
    const dims = document.createElement('span')
    dims.className = 'dims'
    const collapseBtn = document.createElement('button')
    collapseBtn.textContent = '\u2581'
    collapseBtn.title = 'Collapse / expand'
    hd.append(grip, title, dims, collapseBtn)
    tb.appendChild(hd)

    const bd = document.createElement('div')
    bd.className = 'bd'

    // viewport section
    const vpSec = document.createElement('div')
    vpSec.className = 'sec'
    const vpLbl = document.createElement('span')
    vpLbl.className = 'lbl'
    vpLbl.textContent = 'Viewport'
    const presets = document.createElement('select')
    const P = [
      ['Desktop', 1280, 800],
      ['Tablet P', 768, 1024],
      ['Tablet L', 1024, 768],
      ['Mobile P', 390, 844],
      ['Mobile L', 844, 390],
    ]
    P.forEach(function (p) {
      const o = document.createElement('option')
      o.value = p[1] + 'x' + p[2]
      o.textContent = p[0] + ' ' + p[1] + '\u00D7' + p[2]
      presets.appendChild(o)
    })
    const rot = document.createElement('button')
    rot.textContent = '\u21BB'
    rot.title = 'Rotate (swap width/height)'
    vpSec.append(vpLbl, presets, rot)
    bd.appendChild(vpSec)

    // tools section
    const tSec = document.createElement('div')
    tSec.className = 'sec'
    const tLbl = document.createElement('span')
    tLbl.className = 'lbl'
    tLbl.textContent = 'Tools'
    const tools = document.createElement('div')
    tools.className = 'tools'
    const pickBtn = document.createElement('button')
    pickBtn.textContent = 'Pick'
    pickBtn.title = 'Pick an element'
    const drawBtn = document.createElement('button')
    drawBtn.textContent = 'Draw'
    drawBtn.title = 'Draw on the page'
    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear'
    clearBtn.title = 'Clear drawings'
    tools.append(pickBtn, drawBtn, clearBtn)
    tSec.append(tLbl, tools)
    bd.appendChild(tSec)

    // actions section
    const aSec = document.createElement('div')
    aSec.className = 'sec'
    const reloadBtn = document.createElement('button')
    reloadBtn.textContent = 'Reload'
    reloadBtn.title = 'Reload page'
    const sendBtn = document.createElement('button')
    sendBtn.className = 'primary'
    sendBtn.textContent = 'Send \u2192 agent'
    sendBtn.title = 'Capture and send to agent'
    aSec.append(reloadBtn, sendBtn)
    bd.appendChild(aSec)

    const status = document.createElement('div')
    status.className = 'status'
    status.textContent = 'ready'
    bd.appendChild(status)

    tb.appendChild(bd)
    document.body.appendChild(tb)

    // ---- overlays ----
    const hl = document.createElement('div')
    hl.id = '__agent_pick_hl'
    document.body.appendChild(hl)

    const canvas = document.createElement('canvas')
    canvas.id = '__agent_draw'
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')

    // ---- helpers ----
    function vp() { return { width: window.innerWidth, height: window.innerHeight } }
    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = window.innerWidth + 'px'
      canvas.style.height = window.innerHeight + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      redraw()
    }
    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.lineWidth = 3
      ctx.strokeStyle = '#ef4444'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const s of state.strokes) {
        ctx.beginPath()
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.stroke()
      }
    }
    function updateDims() {
      const v = vp()
      dims.textContent = v.width + '\u00D7' + v.height + (v.width < v.height ? ' (P)' : ' (L)')
      resizeCanvas()
    }

    // ---- position (drag + persist) ----
    function clampPos() {
      const W = tb.offsetWidth || 200
      const H = tb.offsetHeight || 40
      let left = tb.offsetLeft
      let top = tb.offsetTop
      left = Math.max(8, Math.min(window.innerWidth - W - 8, left))
      top = Math.max(8, Math.min(window.innerHeight - H - 8, top))
      tb.style.left = left + 'px'
      tb.style.top = top + 'px'
    }
    function positionInitial() {
      let saved = null
      try { saved = JSON.parse(localStorage.getItem('__agent_tb_pos') || 'null') } catch (e) {}
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        tb.style.left = saved.left + 'px'
        tb.style.top = saved.top + 'px'
      } else {
        const W = tb.offsetWidth
        const H = tb.offsetHeight
        tb.style.left = Math.max(8, window.innerWidth - W - 12) + 'px'
        tb.style.top = Math.max(8, window.innerHeight - H - 12) + 'px'
      }
      clampPos()
    }
    function savePos() {
      try { localStorage.setItem('__agent_tb_pos', JSON.stringify({ left: tb.offsetLeft, top: tb.offsetTop })) } catch (e) {}
    }

    let drag = null
    hd.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button') || e.target.closest('select')) return
      drag = { sx: e.clientX, sy: e.clientY, ol: tb.offsetLeft, ot: tb.offsetTop }
      hd.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    hd.addEventListener('pointermove', function (e) {
      if (!drag) return
      tb.style.left = (drag.ol + e.clientX - drag.sx) + 'px'
      tb.style.top = (drag.ot + e.clientY - drag.sy) + 'px'
    })
    hd.addEventListener('pointerup', function () {
      if (!drag) return
      drag = null
      clampPos()
      savePos()
    })

    // ---- collapse ----
    collapseBtn.addEventListener('click', function () {
      state.collapsed = !state.collapsed
      bd.style.display = state.collapsed ? 'none' : 'flex'
      collapseBtn.textContent = state.collapsed ? '\u25A1' : '\u2581'
      clampPos()
    })

    // ---- viewport ----
    presets.addEventListener('change', async function () {
      const wh = presets.value.split('x').map(Number)
      await window.__agentBridge('setViewport', { width: wh[0], height: wh[1] })
      updateDims()
    })
    rot.addEventListener('click', async function () {
      const v = vp()
      await window.__agentBridge('setViewport', { width: v.height, height: v.width })
      updateDims()
    })
    reloadBtn.addEventListener('click', function () { window.__agentBridge('reload', {}) })

    // ---- pick ----
    pickBtn.addEventListener('click', function () {
      state.pick = !state.pick
      pickBtn.classList.toggle('on', state.pick)
      document.body.style.cursor = state.pick ? 'crosshair' : ''
      if (!state.pick) hl.style.display = 'none'
      status.textContent = state.pick ? 'pick: hover an element, then click' : 'ready'
    })
    document.addEventListener('mousemove', function (e) {
      if (!state.pick) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || el.closest('#__agent_tb') || el === hl || el === canvas) { hl.style.display = 'none'; return }
      const r = el.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = r.left + 'px'
      hl.style.top = r.top + 'px'
      hl.style.width = r.width + 'px'
      hl.style.height = r.height + 'px'
    }, true)
    document.addEventListener('click', function (e) {
      if (!state.pick) return
      e.preventDefault()
      e.stopPropagation()
      const el = e.target
      if (!el || el.closest('#__agent_tb')) return
      const r = el.getBoundingClientRect()
      state.picked = {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 120),
        role: el.getAttribute('role') || null,
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      }
      state.pick = false
      pickBtn.classList.toggle('on', false)
      document.body.style.cursor = ''
      hl.style.display = 'none'
      status.textContent = 'picked: ' + state.picked.selector
    }, true)

    // ---- draw ----
    drawBtn.addEventListener('click', function () {
      state.draw = !state.draw
      drawBtn.classList.toggle('danger-on', state.draw)
      canvas.style.pointerEvents = state.draw ? 'auto' : 'none'
      canvas.style.cursor = state.draw ? 'crosshair' : ''
      status.textContent = state.draw ? 'draw: drag to annotate' : 'ready'
    })
    clearBtn.addEventListener('click', function () {
      state.strokes = []
      redraw()
      status.textContent = 'drawings cleared'
    })
    let drawing = false
    let cur = null
    canvas.addEventListener('pointerdown', function (e) {
      if (!state.draw) return
      drawing = true
      cur = { points: [{ x: Math.round(e.clientX), y: Math.round(e.clientY) }] }
      state.strokes.push(cur)
      redraw()
    })
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return
      cur.points.push({ x: Math.round(e.clientX), y: Math.round(e.clientY) })
      redraw()
    })
    window.addEventListener('pointerup', function () { drawing = false })

    // ---- send ----
    sendBtn.addEventListener('click', async function () {
      sendBtn.disabled = true
      sendBtn.textContent = 'Sending\u2026'
      status.textContent = 'sending\u2026'
      const res = await window.__agentBridge('feedback', {
        picked: state.picked,
        drawings: state.strokes,
        note: 'manual toolbar feedback',
      })
      sendBtn.disabled = false
      sendBtn.textContent = 'Send \u2192 agent'
      status.textContent = res && res.ok ? 'sent \u2713 ' + res.id : 'send failed: ' + JSON.stringify(res)
    })

    window.addEventListener('resize', function () { updateDims(); clampPos() })
    positionInitial()
    updateDims()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
