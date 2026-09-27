const $ = (id) => document.getElementById(id)

const els = {
  balanceVal: $('balance-val'),
  availableTag: $('available-tag'),
  spentText: $('spent-text'),
  progressPct: $('progress-pct'),
  progressFill: $('progress-fill'),
  todaySpent: $('today-spent'),
  todayTokens: $('today-tokens'),
  weekTotal: $('week-total'),
  chart: $('chart'),
  updated: $('updated'),
  err: $('err'),
  mainPanel: $('main-panel'),
  setupPanel: $('setup-panel'),
  inApiKey: $('in-api-key'),
  inTopup: $('in-topup'),
  inInterval: $('in-interval'),
  inOpacity: $('in-opacity'),
  inAutostart: $('in-autostart'),
  inThreshold: $('in-threshold'),
  inCooldown: $('in-cooldown'),
  setupMsg: $('setup-msg'),
  btnSync: $('btn-sync'),
  btnClearToken: $('btn-clear-token'),
  tokenStatus: $('token-status'),
  statTokenLabel: $('stat-token-label'),
  btnMenu: $('btn-menu'),
  menu: $('menu'),
  pinLabel: $('pin-label')
}

let currentState = null

function fmtMoney(n) {
  const v = Number(n) || 0
  return v.toFixed(2)
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 万'
  return String(Math.round(v))
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 让窗口高度贴合卡片内容，避免留白
let resizeTimer = null
function autoResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(async () => {
    const card = document.querySelector('.card')
    if (!card) return
    const h = Math.ceil(card.getBoundingClientRect().height) + 16
    if (typeof window.dsApi.setWindowHeight === 'function') {
      await window.dsApi.setWindowHeight(h)
    }
  }, 40)
}

function renderChart(days) {
  const max = Math.max(0.0001, ...days.map((d) => d.spend))
  els.chart.innerHTML = ''
  days.forEach((d) => {
    const wrap = document.createElement('div')
    wrap.className = 'bar-wrap'
    const bar = document.createElement('div')
    bar.className = 'bar'
    const h = d.spend > 0 ? Math.max(4, Math.round((d.spend / max) * 44)) : 2
    bar.style.height = h + 'px'
    bar.title = `${d.label}: ¥${fmtMoney(d.spend)}`
    const lab = document.createElement('div')
    lab.className = 'bar-label'
    lab.textContent = d.label
    wrap.appendChild(bar)
    wrap.appendChild(lab)
    els.chart.appendChild(wrap)
  })
}

function renderState(s) {
  if (!s) return
  currentState = s
  els.err.textContent = ''

  if (s.needConfig) {
    els.updated.textContent = '未配置 API Key'
    openSetup()
    return
  }

  if (!s.ok) {
    els.err.textContent = s.error || '刷新失败'
    if (s.lastState && s.lastState.ok) renderState({ ...s.lastState, ok: true, stale: true })
    return
  }

  els.balanceVal.textContent = fmtMoney(s.total)
  els.spentText.textContent = `已花费 ¥${fmtMoney(s.spent)} / ¥${fmtMoney(s.baseline)}`
  const pct = (s.progress * 100).toFixed(1)
  els.progressPct.textContent = pct + '%'
  els.progressFill.style.width = pct + '%'
  const u = s.usage
  els.todaySpent.textContent = fmtMoney(u ? u.todayCost : s.todaySpent)
  els.todayTokens.textContent = fmtTokens(u ? u.todayTokens : s.todayTokensEst)
  if (els.statTokenLabel) els.statTokenLabel.textContent = u ? '今日 Token（实时）' : '今日 Token（估算）'

  const days =
    u && u.days && u.days.length ? u.days.map((d) => ({ label: d.label, spend: d.cost })) : s.days || []
  const weekSum = days.reduce((a, b) => a + b.spend, 0)
  els.weekTotal.textContent = `合计 ¥${fmtMoney(weekSum)} · ${u ? '官网实时' : '本地估算'}`
  renderChart(days)

  if (s.usageOk === false) {
    els.err.textContent =
      s.usageError === 'AUTH' ? '官网令牌已失效，请重新同步' : s.usageError || '用量获取失败'
  }

  els.availableTag.className = 'tag'
  if (s.isAvailable === false) {
    els.availableTag.textContent = '余额不足'
    els.availableTag.classList.add('warn')
  } else if (s.low) {
    els.availableTag.textContent = `余额偏低（阈值 ¥${fmtMoney(s.lowThreshold)}）`
    els.availableTag.classList.add('warn')
  } else {
    els.availableTag.textContent = ''
  }
  els.balanceVal.parentElement.classList.toggle('low', !!s.low || s.isAvailable === false)

  els.updated.textContent = (s.stale ? '数据可能过期 · ' : '更新于 ') + fmtTime(s.updatedAt)
  autoResize()
}

// ---------- 设置面板 ----------
async function openSetup() {
  const cfg = await window.dsApi.getConfig()
  els.inTopup.value = cfg.topUpTotal || ''
  els.inInterval.value = cfg.pollIntervalSec || 60
  els.inOpacity.value = cfg.opacity || 0.95
  els.inAutostart.checked = !!cfg.autoStart
  els.inThreshold.value = cfg.lowBalanceThreshold || ''
  els.inCooldown.value = cfg.notifyCooldownMin || 60
  els.inApiKey.value = ''
  els.inApiKey.placeholder = cfg.apiKeySet ? `已保存（${cfg.apiKeyMasked}），留空不改动` : 'sk-...'
  els.tokenStatus.textContent = cfg.platformTokenSet
    ? '已同步官网令牌（获取真实数据）'
    : '未同步，当前为本地估算数据'
  els.setupMsg.textContent = ''
  els.mainPanel.classList.add('hidden')
  els.setupPanel.classList.remove('hidden')
  autoResize()
}

function closeSetup() {
  els.setupPanel.classList.add('hidden')
  els.mainPanel.classList.remove('hidden')
  autoResize()
}

async function saveSetup() {
  const apiKey = els.inApiKey.value
  const payload = {
    topUpTotal: Number(els.inTopup.value) || 0,
    pollIntervalSec: Number(els.inInterval.value) || 60,
    opacity: Number(els.inOpacity.value) || 0.95,
    autoStart: els.inAutostart.checked,
    lowBalanceThreshold: Number(els.inThreshold.value) || 0,
    notifyCooldownMin: Number(els.inCooldown.value) || 60
  }
  if (apiKey.trim()) payload.apiKey = apiKey.trim()
  await window.dsApi.saveConfig(payload)
  els.setupMsg.textContent = '已保存，正在刷新…'
  setTimeout(closeSetup, 500)
}

async function exportHistory() {
  const res = await window.dsApi.exportData()
  const msg = res.ok
    ? `已导出 ${res.count} 条记录`
    : res.canceled
    ? '已取消导出'
    : '导出失败：' + (res.error || '未知错误')
  if (!els.setupPanel.classList.contains('hidden')) {
    els.setupMsg.textContent = msg
  } else {
    els.updated.textContent = msg
    setTimeout(() => {
      if (currentState) renderState(currentState)
    }, 2500)
  }
}

// ---------- 菜单 ----------
function setMenuOpen(open) {
  els.menu.classList.toggle('hidden', !open)
  els.btnMenu.classList.toggle('active', open)
}

els.btnMenu.addEventListener('click', (e) => {
  e.stopPropagation()
  setMenuOpen(els.menu.classList.contains('hidden'))
})

document.addEventListener('click', (e) => {
  if (!els.menu.classList.contains('hidden') && !els.menu.contains(e.target)) setMenuOpen(false)
})

document.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', async () => {
    const action = item.dataset.action
    setMenuOpen(false)
    if (action === 'refresh') window.dsApi.refresh()
    else if (action === 'setup') openSetup()
    else if (action === 'export') exportHistory()
    else if (action === 'pin') await window.dsApi.setPinned(true)
    else if (action === 'hide') window.dsApi.hideWindow()
    else if (action === 'quit') window.dsApi.quitApp()
  })
})

// ---------- 悬浮固定 ----------
function applyPinnedUI(isPinned) {
  document.body.classList.toggle('pinned', isPinned)
  if (els.pinLabel) els.pinLabel.textContent = isPinned ? '取消悬浮固定' : '悬浮固定'
  if (isPinned) setMenuOpen(false)
}
window.dsApi.onPinned((d) => applyPinnedUI(!!(d && d.pinned)))
window.dsApi.onOpenSetup(() => openSetup())

// ---------- 设置面板按钮 ----------
$('btn-cancel').addEventListener('click', closeSetup)
$('btn-save').addEventListener('click', saveSetup)
$('btn-sync').addEventListener('click', async () => {
  els.tokenStatus.textContent = '已打开登录窗口，登录后将自动同步…'
  await window.dsApi.startUsageSync()
})
$('btn-clear-token').addEventListener('click', async () => {
  await window.dsApi.clearPlatformToken()
  els.tokenStatus.textContent = '已清除官网令牌，使用本地估算数据'
})
window.dsApi.onTokenSynced((d) => {
  if (d && d.ok) els.tokenStatus.textContent = '已同步官网令牌，正在刷新…'
})
$('link-console').addEventListener('click', (e) => {
  e.preventDefault()
  window.dsApi.openExternal('https://platform.deepseek.com/api_keys')
})

// ---------- 状态订阅 ----------
window.dsApi.onState(renderState)

window.dsApi.getState().then((s) => {
  if (s) renderState(s)
})
