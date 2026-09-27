const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, dialog, Notification, safeStorage, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const https = require('https')

let win = null
let tray = null
let pollTimer = null
let lastState = null

const USER_DIR = app.getPath('userData')
const CONFIG_PATH = path.join(USER_DIR, 'config.json')
const HISTORY_PATH = path.join(USER_DIR, 'history.json')

const DEFAULT_CONFIG = {
  apiKey: '',
  topUpTotal: 0,
  pollIntervalSec: 60,
  opacity: 1,
  autoStart: false,
  lowBalanceThreshold: 0,
  notifyCooldownMin: 60,
  platformToken: ''
}

// ---------- 配置与历史读写 ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    console.error('写入文件失败:', file, e)
  }
}

let config = { ...DEFAULT_CONFIG }
let history = []

// ---------- 敏感字段加密（优先使用系统凭据保护，不可用时退回明文） ----------
function encryptSecret(plain) {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:v1:' + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (e) {
    console.error('加密失败:', e)
  }
  return plain
}

function decryptSecret(stored) {
  if (!stored) return ''
  if (String(stored).startsWith('enc:v1:')) {
    try {
      return safeStorage.decryptString(Buffer.from(String(stored).slice(7), 'base64'))
    } catch (e) {
      console.error('解密失败:', e)
      return ''
    }
  }
  return stored
}

function loadAll() {
  config = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_PATH, {}) }
  config.apiKey = decryptSecret(config.apiKey)
  config.platformToken = decryptSecret(config.platformToken)
  history = readJSON(HISTORY_PATH, [])
  if (!Array.isArray(history)) history = []
}

function saveConfig() {
  const serializable = {
    ...config,
    apiKey: encryptSecret(config.apiKey),
    platformToken: encryptSecret(config.platformToken)
  }
  writeJSON(CONFIG_PATH, serializable)
}

// 应用开机自启设置
function applyAutoStart() {
  try {
    const opts = { openAtLogin: !!config.autoStart, path: process.execPath }
    // 开发模式下需要额外传入项目路径；打包后直接启动自身
    opts.args = app.isPackaged ? [] : [path.resolve(__dirname)]
    app.setLoginItemSettings(opts)
  } catch (e) {
    console.error('设置开机自启失败:', e)
  }
}

function saveHistory() {
  const cutoff = Date.now() - 90 * 86400000
  history = history.filter((h) => h && h.t >= cutoff)
  writeJSON(HISTORY_PATH, history)
}

// ---------- 余额过低提醒 ----------
let lastNotifyAt = 0
let belowThreshold = false

function notifyLowBalance(total, threshold) {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'DeepSeek 余额偏低',
        body: `当前余额 ¥${total.toFixed(2)}，已低于提醒阈值 ¥${threshold.toFixed(2)}。`,
        urgency: 'critical'
      }).show()
    }
  } catch (e) {
    console.error('发送通知失败:', e)
  }
}

function checkLowBalance(state) {
  const threshold = Number(config.lowBalanceThreshold) || 0
  if (threshold <= 0) {
    belowThreshold = false
    return
  }
  if (state.total <= threshold) {
    const now = Date.now()
    const cooldown = Math.max(5, Number(config.notifyCooldownMin) || 60) * 60000
    // 首次跌破或超过冷却时间后再次提醒
    if (!belowThreshold || now - lastNotifyAt >= cooldown) {
      notifyLowBalance(state.total, threshold)
      lastNotifyAt = now
    }
    belowThreshold = true
  } else {
    belowThreshold = false
  }
}

// ---------- 数据导出 ----------
function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatTs(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`
}

function historyToCSV(rows) {
  const header = '时间,余额,赠送余额,充值余额'
  const lines = rows.map(
    (r) =>
      `${formatTs(r.t)},${Number(r.total).toFixed(4)},${Number(r.granted || 0).toFixed(
        4
      )},${Number(r.toppedUp || 0).toFixed(4)}`
  )
  // 添加 BOM，便于 Excel 正确识别中文
  return '\ufeff' + [header, ...lines].join('\r\n')
}

async function exportData() {
  if (!history.length) {
    return { ok: false, error: '暂无历史数据可导出' }
  }
  const stamp = formatTs(Date.now()).slice(0, 10)
  const res = await dialog.showSaveDialog(win, {
    title: '导出余额历史',
    defaultPath: `deepseek-balance-${stamp}.csv`,
    filters: [
      { name: 'CSV 文件（Excel 可直接打开）', extensions: ['csv'] },
      { name: 'JSON 文件', extensions: ['json'] }
    ]
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  try {
    const isJson = res.filePath.toLowerCase().endsWith('.json')
    const content = isJson ? JSON.stringify(history, null, 2) : historyToCSV(history)
    fs.writeFileSync(res.filePath, content, 'utf8')
    return { ok: true, path: res.filePath, count: history.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// ---------- 生成托盘/窗口图标（内嵌 PNG，避免外部资源依赖） ----------
function crc32(buf) {
  if (!crc32.table) {
    const t = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    crc32.table = t
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function makeIconPNG(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  let o = 0
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const r = size / 2 - 1
  for (let y = 0; y < size; y++) {
    raw[o++] = 0
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy)
      const inside = d <= r
      raw[o++] = 0x4d
      raw[o++] = 0x6b
      raw[o++] = 0xfe
      raw[o++] = inside ? 255 : 0
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 调用 DeepSeek 余额接口 ----------
function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.deepseek.com',
        path: '/user/balance',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        timeout: 15000
      },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let hint = ''
            if (res.statusCode === 401) hint = '：API Key 无效或已过期'
            if (res.statusCode === 402) hint = '：账户余额不足'
            return reject(new Error(`HTTP ${res.statusCode}${hint} ${body.slice(0, 160)}`))
          }
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new Error('返回内容解析失败'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时，请检查网络')))
    req.on('error', (e) => reject(e))
    req.end()
  })
}

// ---------- 平台（官网）用量接口 ----------
// 说明：以下为 DeepSeek 官网控制台使用的内部接口，非官方公开 API，
// 需要登录后的平台令牌（platformToken），可能随官网改版而失效。
function httpGetJson(url, token) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return reject(new Error('无效的地址'))
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: '*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'x-app-version': '1.0.0'
        },
        timeout: 15000
      },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: body ? JSON.parse(body) : {} })
          } catch (e) {
            reject(new Error('返回内容解析失败'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时，请检查网络')))
    req.on('error', (e) => reject(e))
    req.end()
  })
}

function isAuthError(...codes) {
  return codes.some((c) => c === 40002 || c === 40003 || c === 401)
}

function assertOk(payload, label) {
  const code = payload?.code ?? 0
  const bizCode = payload?.data?.biz_code ?? 0
  if (isAuthError(code, bizCode)) throw new Error('AUTH')
  if (code !== 0 || bizCode !== 0) {
    throw new Error(`${label}接口错误 (code ${code}/${bizCode})`)
  }
}

function sumTokens(entries) {
  let tokens = 0
  let requests = 0
  for (const e of entries || []) {
    const type = e.type || e.kind || ''
    const v = Math.round(Number(e.amount || 0))
    if (type === 'REQUEST') requests += v
    else tokens += v
  }
  return { tokens, requests }
}

function sumCost(entries) {
  return (entries || [])
    .filter((e) => (e.type || e.kind) !== 'REQUEST')
    .reduce((s, e) => s + Number(e.amount || 0), 0)
}

function parseUsage(amountPayload, costPayload) {
  const aBiz = amountPayload?.data?.biz_data || {}
  const cRaw = costPayload?.data?.biz_data
  const cBiz = Array.isArray(cRaw) ? cRaw[0] || {} : cRaw || {}
  const currency = cBiz.currency || 'CNY'

  const costByDate = new Map()
  for (const day of cBiz.days || []) {
    costByDate.set(day.date, (day.data || []).reduce((s, it) => s + sumCost(it.usage), 0))
  }

  const map = new Map()
  for (const day of aBiz.days || []) {
    const agg = (day.data || []).reduce(
      (acc, it) => {
        const t = sumTokens(it.usage)
        acc.tokens += t.tokens
        acc.requests += t.requests
        return acc
      },
      { tokens: 0, requests: 0 }
    )
    map.set(day.date, {
      date: day.date,
      tokens: agg.tokens,
      requests: agg.requests,
      cost: costByDate.get(day.date) || 0
    })
  }
  for (const [date, cost] of costByDate) {
    if (!map.has(date)) map.set(date, { date, tokens: 0, requests: 0, cost })
  }
  const allDays = [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))

  let monthTokens = 0
  let monthRequests = 0
  let monthCost = 0
  for (const d of allDays) {
    monthTokens += d.tokens
    monthRequests += d.requests
    monthCost += d.cost
  }

  const todayStr = formatTs(Date.now()).slice(0, 10)
  const today = allDays.find((d) => d.date === todayStr) || { tokens: 0, requests: 0, cost: 0 }

  return {
    currency,
    todayTokens: today.tokens,
    todayCost: today.cost,
    todayRequests: today.requests,
    monthTokens,
    monthRequests,
    monthCost,
    days: allDays.slice(-7).map((d) => ({
      label: String(d.date).slice(5).replace('-', '/'),
      cost: d.cost,
      tokens: d.tokens
    }))
  }
}

async function fetchPlatformUsage() {
  const token = config.platformToken
  if (!token) return null
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()
  const base = 'https://platform.deepseek.com/api/v0/usage'
  const [amount, cost] = await Promise.all([
    httpGetJson(`${base}/amount?month=${month}&year=${year}`, token),
    httpGetJson(`${base}/cost?month=${month}&year=${year}`, token)
  ])
  assertOk(amount.json, '用量')
  assertOk(cost.json, '消费')
  return parseUsage(amount.json, cost.json)
}

async function fetchPlatformBalance() {
  const token = config.platformToken
  if (!token) return null
  const { json } = await httpGetJson('https://platform.deepseek.com/api/v0/users/get_user_summary', token)
  assertOk(json, '账户')
  const d = json?.data?.biz_data || {}
  const sumBy = (list, cur) =>
    (list || []).filter((w) => w.currency === cur).reduce((s, w) => s + Number(w.balance || 0), 0)
  const granted = sumBy(d.bonus_wallets, 'CNY')
  const toppedUp = sumBy(d.normal_wallets, 'CNY')
  const total = granted + toppedUp
  return {
    is_available: total > 0,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: String(total),
        granted_balance: String(granted),
        topped_up_balance: String(toppedUp)
      }
    ]
  }
}

// ---------- 官网登录同步平台令牌 ----------
let syncWin = null
let tokenCapturedFlag = false

async function verifyPlatformToken(token) {
  try {
    const now = new Date()
    const { json } = await httpGetJson(
      `https://platform.deepseek.com/api/v0/usage/amount?month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
      token
    )
    const code = json?.code ?? 0
    const bizCode = json?.data?.biz_code ?? 0
    return !isAuthError(code, bizCode) && code === 0
  } catch {
    return false
  }
}

function acceptCapturedToken(token) {
  if (tokenCapturedFlag || !token || token.length < 20) return
  tokenCapturedFlag = true
  verifyPlatformToken(token)
    .then((ok) => {
      if (!ok) {
        tokenCapturedFlag = false
        return
      }
      config.platformToken = token
      saveConfig()
      if (win && !win.isDestroyed()) win.webContents.send('token-synced', { ok: true })
      if (syncWin && !syncWin.isDestroyed()) syncWin.close()
      refresh()
    })
    .catch(() => {
      tokenCapturedFlag = false
    })
}

function startUsageSync() {
  if (syncWin && !syncWin.isDestroyed()) {
    syncWin.show()
    syncWin.focus()
    return { ok: true }
  }
  tokenCapturedFlag = false
  syncWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: '登录 DeepSeek 同步用量数据',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:ds-platform',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const ses = syncWin.webContents.session
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://platform.deepseek.com/*'] }, (details, callback) => {
    const h = details.requestHeaders || {}
    const auth = h.Authorization || h.authorization
    if (auth && !tokenCapturedFlag) {
      const m = /Bearer\s+(\S+)/i.exec(auth)
      if (m) acceptCapturedToken(m[1])
    }
    callback({ requestHeaders: details.requestHeaders })
  })
  syncWin.on('closed', () => {
    syncWin = null
  })
  syncWin.loadURL('https://platform.deepseek.com/usage')
  return { ok: true }
}

// ---------- 状态计算 ----------
function computeState(resp) {
  const infos = (resp && resp.balance_infos) || []
  const info = infos.find((i) => i.currency === 'CNY') || infos[0] || {}
  const total = Number(info.total_balance || 0)
  const granted = Number(info.granted_balance || 0)
  const toppedUp = Number(info.topped_up_balance || 0)
  const now = Date.now()

  // 记录余额历史（变化或间隔较久时写入）
  const last = history[history.length - 1]
  if (!last || now - last.t > 5 * 60 * 1000 || Math.abs(last.total - total) > 1e-6) {
    history.push({ t: now, total, granted, toppedUp })
    saveHistory()
  }

  // 花费进度：以用户填写的充值总额为基准，未填写则用当前余额为基准
  const baseline = config.topUpTotal > 0 ? config.topUpTotal : total
  const spent = Math.max(0, baseline - total)
  const progress = baseline > 0 ? Math.min(1, spent / baseline) : 0

  // 今日消费
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayStartTs = dayStart.getTime()
  const beforeToday = [...history].reverse().find((h) => h.t < dayStartTs)
  const firstToday = history.find((h) => h.t >= dayStartTs)
  const dayBase = beforeToday ? beforeToday.total : firstToday ? firstToday.total : total
  const todaySpent = Math.max(0, dayBase - total)

  // 近 7 天消费
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d0 = new Date()
    d0.setHours(0, 0, 0, 0)
    d0.setDate(d0.getDate() - i)
    const d1 = new Date(d0)
    d1.setDate(d1.getDate() + 1)
    const t0 = d0.getTime()
    const t1 = d1.getTime()
    const before = [...history].reverse().find((h) => h.t < t0)
    const within = history.filter((h) => h.t >= t0 && h.t < t1)
    const startBal = before ? before.total : within.length ? within[0].total : null
    const endBal = within.length ? within[within.length - 1].total : startBal
    const spend = startBal != null && endBal != null ? Math.max(0, startBal - endBal) : 0
    days.push({ label: `${d0.getMonth() + 1}/${d0.getDate()}`, spend })
  }

  // Token 估算：按 deepseek-chat 混合单价约 ¥5/百万 tokens 粗略估算
  const PRICE_PER_MILLION = 5
  const todayTokensEst = Math.round((todaySpent / PRICE_PER_MILLION) * 1e6)
  const totalTokensEst = Math.round((spent / PRICE_PER_MILLION) * 1e6)

  const lowThreshold = Number(config.lowBalanceThreshold) || 0
  const low = lowThreshold > 0 && total <= lowThreshold

  return {
    ok: true,
    currency: info.currency || 'CNY',
    isAvailable: resp ? resp.is_available !== false : true,
    low,
    lowThreshold,
    total,
    granted,
    toppedUp,
    baseline,
    spent,
    progress,
    todaySpent,
    todayTokensEst,
    totalTokensEst,
    days,
    updatedAt: now
  }
}

// ---------- 与渲染进程通信 ----------
function sendState(state) {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send('state', state)
  }
}

async function refresh() {
  if (!config.apiKey && !config.platformToken) {
    const s = { ok: false, needConfig: true, error: '尚未配置 API Key 或平台令牌' }
    lastState = s
    sendState(s)
    return s
  }
  try {
    const resp = config.apiKey ? await fetchBalance(config.apiKey) : await fetchPlatformBalance()
    const state = computeState(resp)
    if (config.platformToken) {
      try {
        state.usage = await fetchPlatformUsage()
        state.usageOk = true
      } catch (e) {
        state.usageOk = false
        state.usageError = String((e && e.message) || e)
      }
    }
    lastState = state
    sendState(state)
    updateTray(state)
    checkLowBalance(state)
    return state
  } catch (e) {
    const s = { ok: false, error: String((e && e.message) || e), lastState }
    lastState = s
    sendState(s)
    return s
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  const sec = Math.max(15, Number(config.pollIntervalSec) || 60)
  pollTimer = setInterval(() => refresh(), sec * 1000)
}

function updateTray(state) {
  if (!tray) return
  const spentToday = state && state.ok ? (state.usage ? state.usage.todayCost : state.todaySpent) : 0
  const base =
    state && state.ok
      ? `DeepSeek 余额 ¥${state.total.toFixed(2)}\n今日消费 ¥${Number(spentToday).toFixed(2)}`
      : 'DeepSeek 用量监控'
  tray.setToolTip(pinned ? base + '\n(已固定 · 鼠标穿透)' : base)
}

// ---------- 窗口与托盘 ----------
function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: 320,
    height: 470,
    x: workAreaSize.width - 360,
    y: 60,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 沉到桌面层：不置顶，其他任何窗口都可正常遮挡悬浮窗
  win.setAlwaysOnTop(false)
  win.setOpacity(Math.min(1, Math.max(0.3, Number(config.opacity) || 1)))
  win.loadFile(path.join(__dirname, 'src', 'index.html'))
  win.on('closed', () => (win = null))
}

// ---------- 悬浮固定（鼠标穿透） ----------
let pinned = false

function setPinned(v) {
  pinned = !!v
  if (win && !win.isDestroyed()) {
    try {
      if (pinned) win.setIgnoreMouseEvents(true, { forward: true })
      else win.setIgnoreMouseEvents(false)
    } catch (e) {
      console.error('设置鼠标穿透失败:', e)
    }
    if (win.webContents) win.webContents.send('pinned-changed', { pinned })
  }
  rebuildTrayMenu()
  return { ok: true, pinned }
}

function showWindowAndSend(channel) {
  if (!win || win.isDestroyed()) createWindow()
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  if (win.webContents) win.webContents.send(channel)
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示/隐藏悬浮窗', click: () => toggleWindow() },
    { label: '立即刷新', click: () => refresh() },
    { type: 'separator' },
    { label: pinned ? '取消悬浮固定' : '悬浮固定（鼠标穿透）', click: () => setPinned(!pinned) },
    { label: '设置…', click: () => showWindowAndSend('open-setup') },
    { type: 'separator' },
    {
      label: '打开 DeepSeek 控制台',
      click: () => shell.openExternal('https://platform.deepseek.com/usage')
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  const icon = nativeImage.createFromBuffer(makeIconPNG(32))
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek 用量监控')
  rebuildTrayMenu()
  tray.on('click', () => toggleWindow())
}

function toggleWindow() {
  if (!win) return createWindow()
  if (win.isVisible()) win.hide()
  else win.show()
}

// ---------- IPC ----------
ipcMain.handle('get-state', async () => {
  if (!lastState) await refresh()
  return lastState
})

ipcMain.handle('get-config', () => ({
  topUpTotal: config.topUpTotal,
  pollIntervalSec: config.pollIntervalSec,
  opacity: config.opacity,
  autoStart: config.autoStart,
  lowBalanceThreshold: config.lowBalanceThreshold,
  notifyCooldownMin: config.notifyCooldownMin,
  apiKeySet: !!config.apiKey,
  apiKeyMasked: config.apiKey ? config.apiKey.slice(0, 6) + '****' + config.apiKey.slice(-4) : '',
  platformTokenSet: !!config.platformToken
}))

ipcMain.handle('save-config', (_e, cfg) => {
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.apiKey === 'string') config.apiKey = cfg.apiKey.trim()
    if (cfg.topUpTotal !== undefined) config.topUpTotal = Number(cfg.topUpTotal) || 0
    if (cfg.pollIntervalSec !== undefined)
      config.pollIntervalSec = Math.max(15, Number(cfg.pollIntervalSec) || 60)
    if (cfg.opacity !== undefined) config.opacity = Number(cfg.opacity) || 1
    if (cfg.autoStart !== undefined) config.autoStart = !!cfg.autoStart
    if (typeof cfg.platformToken === 'string' && cfg.platformToken.trim())
      config.platformToken = cfg.platformToken.trim()
    if (cfg.clearPlatformToken) config.platformToken = ''
    if (cfg.lowBalanceThreshold !== undefined)
      config.lowBalanceThreshold = Math.max(0, Number(cfg.lowBalanceThreshold) || 0)
    if (cfg.notifyCooldownMin !== undefined)
      config.notifyCooldownMin = Math.max(5, Number(cfg.notifyCooldownMin) || 60)
  }
  saveConfig()
  if (win && !win.isDestroyed()) {
    win.setOpacity(Math.min(1, Math.max(0.3, Number(config.opacity) || 1)))
  }
  applyAutoStart()
  startPolling()
  refresh()
  return { ok: true }
})

ipcMain.handle('export-data', () => exportData())
ipcMain.handle('start-usage-sync', () => startUsageSync())
ipcMain.handle('set-pinned', (_e, v) => setPinned(v))
ipcMain.handle('set-window-height', (_e, h) => {
  if (win && !win.isDestroyed()) {
    const height = Math.max(220, Math.min(1000, Math.round(Number(h) || 0)))
    const b = win.getBounds()
    if (b.height !== height) win.setBounds({ x: b.x, y: b.y, width: b.width, height })
  }
  return { ok: true }
})
ipcMain.handle('clear-platform-token', () => {
  config.platformToken = ''
  saveConfig()
  refresh()
  return { ok: true }
})
ipcMain.handle('refresh', () => refresh())
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url))
ipcMain.handle('hide-window', () => win && win.hide())
ipcMain.handle('quit-app', () => app.quit())

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    loadAll()
    applyAutoStart()
    createWindow()
    createTray()
    globalShortcut.register('CommandOrControl+Alt+D', () => setPinned(!pinned))
    startPolling()
    refresh()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  app.on('window-all-closed', (e) => {
    // 保持后台运行
  })
}
