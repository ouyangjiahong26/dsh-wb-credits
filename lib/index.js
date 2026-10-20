// dsh-wb-credits —— WorkBuddy 中转站积分看板（host 端）
//
// 职责：
//   1. 用「只读账号」登录中转站面板 pm.cislunarspace.cn，拿本 key 的已用积分 / 今日消耗；
//   2. 登录不可用时退回网关 /v1/usage（只需 wbk_ key，无需登录）；
//   3. 通过 webServer 把数据以 JSON 路由喂给浏览器端小挂件（assets/badge.js）；
//   4. 把脚本注入 Web 页面（tapIndex 走 SPA，index-inject 走桌面壳）。
//
// 不写任何面板数据：只发 GET 统计接口 + 一个 POST /api/login。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const CONFIG_FILE = path.join(DSH_HOME, '.dshw-credits.json')
const CACHE_FILE = path.join(DSH_HOME, '.dshw-credits-state.json')
const ICON_DIR = path.join(DSH_HOME, 'wb-credits')
const ICON_BASE = path.join(ICON_DIR, 'icon')
const ICON_EXTS = ['png', 'jpg', 'gif', 'webp']
const ICON_MAX_BYTES = 2 * 1024 * 1024
const ROUTE = '/dsh-wb-credits'
const TAG = '[dsh-wb-credits]'

const DEFAULT_REFRESH_MS = 5 * 60 * 1000
const MIN_REFRESH_MS = 60 * 1000
const SESSION_MARGIN_S = 3600 // 会话剩余不足 1 小时就提前重登
const HTTP_TIMEOUT_MS = 15000

const DEFAULT_CONFIG = {
  version: 1,
  panelUrl: 'https://pm.cislunarspace.cn',
  // 网关（OpenAI 兼容）：留空＝从 DSH 自己的模型 provider 配置里自动识别。
  // 填了就用填的，方便一个机器上有多套网关的人手动指定。
  gatewayUrl: '',
  keyRef: '',
  username: '',
  secret: null, // { sealed: boolean, value: string }
  keyPrefix: '',
  refreshMs: DEFAULT_REFRESH_MS,
  enabled: true,
  // 阈值：metric = used（本 key 累计）| today（本 key 今日）| pool（全站余额，反向）
  thresholds: { metric: 'used', warn: 500, alert: 1000 },
  icon: null, // { ext, updatedAt }
  updatedAt: 0,
}

// ───────────────────────────── 小工具 ─────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    console.warn(TAG, '写文件失败', file, err && err.message)
    return false
  }
}

function round2(n) {
  const v = Number(n)
  return isFinite(v) ? Math.round(v * 100) / 100 : null
}

function beijingDay(ms) {
  const d = new Date((Number(ms) || Date.now()) + 8 * 3600 * 1000)
  const b = d.toISOString()
  return b.slice(0, 10)
}

function fmtTs(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

// ─────────────────────────── 阈值 ───────────────────────────
//
// metric:
//   used  —— 本 key 累计已用（越大越糟）
//   today —— 本 key 今日已用（越大越糟）
//   pool  —— 全站积分余额（越小越糟，方向相反）
// warn / alert 两个阈值不要求大小顺序：一律按 min/max 归一，避免用户填反了不生效。

const THRESHOLD_METRICS = ['used', 'today', 'pool']

function normalizeThresholds(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  const metric = THRESHOLD_METRICS.includes(t.metric) ? t.metric : 'used'
  const warn = isFinite(Number(t.warn)) ? Number(t.warn) : 500
  const alert = isFinite(Number(t.alert)) ? Number(t.alert) : 1000
  return { metric, warn, alert }
}

function computeThreshold(state, cfg) {
  const t = normalizeThresholds(cfg && cfg.thresholds)
  const cur = state || {}
  let value = null
  if (t.metric === 'today') value = cur.today ? Number(cur.today.credit) : null
  else if (t.metric === 'pool') value = cur.pool ? Number(cur.pool.credits) : null
  else value = cur.key ? Number(cur.key.usedCredit) : null

  const result = { metric: t.metric, warn: t.warn, alert: t.alert, value, level: 'ok' }
  if (value == null || !isFinite(value)) return result

  const lo = Math.min(t.warn, t.alert)
  const hi = Math.max(t.warn, t.alert)
  if (t.metric === 'pool') {
    // 余额越低越糟
    if (value <= lo) result.level = 'alert'
    else if (value <= hi) result.level = 'warn'
  } else {
    if (value >= hi) result.level = 'alert'
    else if (value >= lo) result.level = 'warn'
  }
  return result
}

// ─────────────────────────── 图标 ───────────────────────────

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: 'gif', mime: 'image/gif' }
  const riff = b.slice(0, 4).toString('ascii')
  const webp = b.slice(8, 12).toString('ascii')
  if (riff === 'RIFF' && webp === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}

function findIcon() {
  for (const ext of ICON_EXTS) {
    const file = ICON_BASE + '.' + ext
    try {
      if (fs.existsSync(file)) return { file, ext, mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) }
    } catch (err) {}
  }
  return null
}

function clearIcons() {
  for (const ext of ICON_EXTS) {
    const file = ICON_BASE + '.' + ext
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (err) {}
  }
}

function readRawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error('文件过大（上限 ' + Math.round(limit / 1024) + ' KB）'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ─────────────────────────── DPAPI 封装 ───────────────────────────
//
// 面板密码落盘前用 Windows DPAPI（CurrentUser 作用域）加密：文件被拷到别的机器/用户下解不开。
// DPAPI 只能通过 .NET 调用，这里起一个隐藏的 powershell 子进程，密码经 stdin 传递（不进命令行）。

const DPAPI_LOAD = 'Add-Type -AssemblyName System.Security -ErrorAction Stop;'

function runPowerShell(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || err).trim()))
        resolve(String(stdout || '').trim())
      },
    )
    try {
      child.stdin.end(String(stdin == null ? '' : stdin), 'utf8')
    } catch (err) {
      /* 子进程可能已退出 */
    }
  })
}

async function dpapiSeal(text) {
  const script =
    DPAPI_LOAD +
    '$s=[Console]::In.ReadToEnd();' +
    '$b=[Text.Encoding]::UTF8.GetBytes($s);' +
    '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,"CurrentUser");' +
    '[Convert]::ToBase64String($p)'
  return runPowerShell(script, text)
}

async function dpapiUnseal(b64) {
  const script =
    DPAPI_LOAD +
    '$s=[Console]::In.ReadToEnd();' +
    '$p=[Convert]::FromBase64String($s);' +
    '$d=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,"CurrentUser");' +
    '[Text.Encoding]::UTF8.GetString($d)'
  return runPowerShell(script, b64)
}

async function sealSecret(plain) {
  const text = String(plain || '')
  if (!text) return null
  try {
    return { sealed: true, value: await dpapiSeal(text) }
  } catch (err) {
    console.warn(TAG, 'DPAPI 加密不可用，改为明文保存：' + (err && err.message))
    return { sealed: false, value: text }
  }
}

async function unsealSecret(secret) {
  if (!secret || typeof secret !== 'object' || typeof secret.value !== 'string') return ''
  if (secret.sealed === false) return secret.value
  try {
    return await dpapiUnseal(secret.value)
  } catch (err) {
    console.warn(TAG, 'DPAPI 解密失败：' + (err && err.message))
    return ''
  }
}

// ─────────────────────────── HTTP 客户端 ───────────────────────────

async function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = HTTP_TIMEOUT_MS } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ac.signal,
      redirect: 'manual',
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (err) {
      json = null
    }
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    return { status: res.status, json, text, setCookies }
  } finally {
    clearTimeout(timer)
  }
}

function sessionExpiry(cookie) {
  const m = /(?:^|;\s*)wb_session=([^;]+)/.exec(String(cookie || ''))
  if (!m) return 0
  try {
    // cookie 的形态是 base64url( `${json}|${hmac}` )：整段编码，`|` 也在里面。
    const norm = m[1].replace(/-/g, '+').replace(/_/g, '/')
    const text = Buffer.from(norm, 'base64').toString('utf8')
    const jsonText = /{[\s\S]*?}/.exec(text)
    if (!jsonText) return 0
    const json = JSON.parse(jsonText[0])
    return Number(json.exp) || 0
  } catch (err) {
    return 0
  }
}

function cookieFrom(setCookies) {
  for (const raw of setCookies || []) {
    const head = String(raw).split(';')[0].trim()
    if (head.startsWith('wb_session=')) return head
  }
  return ''
}

// ─────────────────────────── 配置读写 ───────────────────────────

function loadConfig() {
  const raw = readJson(CONFIG_FILE, null)
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.panelUrl = String(cfg.panelUrl || DEFAULT_CONFIG.panelUrl).replace(/\/+$/, '')
  cfg.gatewayUrl = String(cfg.gatewayUrl || DEFAULT_CONFIG.gatewayUrl).replace(/\/+$/, '')
  cfg.keyRef = String(cfg.keyRef || DEFAULT_CONFIG.keyRef).trim()
  cfg.refreshMs = Math.max(MIN_REFRESH_MS, Number(cfg.refreshMs) || DEFAULT_REFRESH_MS)
  cfg.thresholds = normalizeThresholds(cfg.thresholds)
  return cfg
}

function saveConfig(next) {
  const cfg = { ...DEFAULT_CONFIG, ...(next || {}) }
  cfg.panelUrl = String(cfg.panelUrl || DEFAULT_CONFIG.panelUrl).replace(/\/+$/, '')
  cfg.gatewayUrl = String(cfg.gatewayUrl || DEFAULT_CONFIG.gatewayUrl).replace(/\/+$/, '')
  cfg.keyRef = String(cfg.keyRef || DEFAULT_CONFIG.keyRef).trim()
  cfg.refreshMs = Math.max(MIN_REFRESH_MS, Number(cfg.refreshMs) || DEFAULT_REFRESH_MS)
  cfg.thresholds = normalizeThresholds(cfg.thresholds)
  cfg.updatedAt = Date.now()
  writeJson(CONFIG_FILE, cfg)
  return cfg
}

// ─────────────────────────── 运行时状态 ───────────────────────────

const runtime = {
  cookie: '',
  cookieExp: 0,
  state: null,
  timer: null,
  inflight: null,
  lastError: '',
  fallbackDay: null, // { day, used } —— A 档今日增量的基准
}

function emptyState(mode, error) {
  return {
    ok: mode === 'panel' || mode === 'fallback',
    mode,
    error: error || '',
    updatedAt: Date.now(),
    stale: false,
    key: null,
    today: null,
    panel: null,
    pool: null,
    threshold: null,
    auth: null,
  }
}

function loadCachedState() {
  const raw = readJson(CACHE_FILE, null)
  if (!raw || typeof raw !== 'object' || !raw.state) return
  runtime.state = { ...raw.state, stale: true }
  if (raw.fallbackDay) runtime.fallbackDay = raw.fallbackDay
}

function persistState() {
  writeJson(CACHE_FILE, { version: 1, savedAt: Date.now(), state: runtime.state, fallbackDay: runtime.fallbackDay })
}

// ─────────────────────────── 面板数据采集 ───────────────────────────

async function panelLogin(cfg, password) {
  const res = await requestJson(cfg.panelUrl + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password }),
  })
  if (res.status !== 200) {
    throw new Error('面板登录失败：' + (res.json && res.json.detail ? res.json.detail : 'HTTP ' + res.status))
  }
  const cookie = cookieFrom(res.setCookies)
  if (!cookie) throw new Error('面板登录成功但没有拿到 wb_session')
  runtime.cookie = cookie
  runtime.cookieExp = sessionExpiry(cookie)
  return cookie
}

async function panelGet(cfg, pathname) {
  const res = await requestJson(cfg.panelUrl + pathname, {
    headers: { Cookie: runtime.cookie, Accept: 'application/json' },
  })
  return res
}

function needRelogin() {
  if (!runtime.cookie) return true
  const now = Math.floor(Date.now() / 1000)
  return runtime.cookieExp > 0 && runtime.cookieExp - now < SESSION_MARGIN_S
}

// 用本机实际在用的 CISLUNAR_API_KEY 反推 key 前缀，这样面板里永远锁定「你正在花的这把」。
async function primeDerivedPrefix(ctx, cfg) {
  if (runtime.derivedPrefix) return runtime.derivedPrefix
  try {
    const gw = await resolveGateway(ctx, cfg)
    const key = gw ? await resolveGatewayKey(ctx, gw.ref) : ''
    if (key) runtime.derivedPrefix = key.slice(0, 12).toLowerCase()
  } catch (err) {
    /* 取不到就靠 keyPrefix 或最近使用 */
  }
  return runtime.derivedPrefix || ''
}

async function collectPanel(ctx, cfg, password) {
  if (needRelogin()) await panelLogin(cfg, password)

  const once = async () => {
    const me = await panelGet(cfg, '/api/me')
    if (me.status === 401) return { relogin: true }
    if (me.status !== 200 || !me.json) throw new Error('面板 /api/me 返回 ' + me.status)

    const keys = await panelGet(cfg, '/api/keys')
    if (keys.status === 401) return { relogin: true }
    if (keys.status !== 200 || !Array.isArray(keys.json)) throw new Error('面板 /api/keys 返回 ' + keys.status)

    const byKey = await panelGet(cfg, '/api/stats/by-key?days=1')
    const summary = await panelGet(cfg, '/api/stats/summary')
    const accounts = await panelGet(cfg, '/api/accounts')

    return {
      me: me.json,
      keys: keys.json,
      byKey: Array.isArray(byKey.json) ? byKey.json : [],
      summary: summary.json || null,
      accounts: accounts.status === 200 && accounts.json ? accounts.json : null,
    }
  }

  let data = await once()
  if (data.relogin) {
    await panelLogin(cfg, password)
    data = await once()
    if (data.relogin) throw new Error('面板会话失效（重登后仍 401）')
  }

  await primeDerivedPrefix(ctx, cfg)

  const wanted = String(cfg.keyPrefix || '').trim().toLowerCase()
  const derived = runtime.derivedPrefix || ''
  const match =
    (wanted && data.keys.find((k) => String(k.prefix || '').toLowerCase() === wanted)) ||
    (derived && data.keys.find((k) => String(k.prefix || '').toLowerCase() === derived)) ||
    data.keys.slice().sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0))[0]

  if (!match) throw new Error('面板里没找到这把 key')

  const todayRow = data.byKey.find((r) => r && r.name === match.name) || null

  return {
    ok: true,
    mode: 'panel',
    error: '',
    updatedAt: Date.now(),
    stale: false,
    key: {
      name: match.name,
      prefix: match.prefix,
      usedCredit: round2(match.used_credit),
      usedTokens: Number(match.used_tokens) || 0,
      quotaCredit: round2(match.quota_credit),
      lastUsedAt: fmtTs(match.last_used_at),
    },
    today: todayRow
      ? {
          credit: round2(todayRow.credit),
          requests: Number(todayRow.requests) || 0,
          promptTokens: Number(todayRow.prompt_tokens) || 0,
          completionTokens: Number(todayRow.completion_tokens) || 0,
        }
      : { credit: 0, requests: 0, promptTokens: 0, completionTokens: 0 },
    panel: data.summary
      ? {
          todayCredit: round2(data.summary.today_credit),
          todayRequests: Number(data.summary.today_requests) || 0,
          todayTokens: Number(data.summary.today_tokens) || 0,
          weekCredit: round2(data.summary.week_credit),
          activeKeys: Number(data.summary.active_keys) || 0,
          topModel: data.summary.top_model || '',
        }
      : null,
    // 全站积分余额：只有 /api/accounts 里每个账号的 credits 求和才是「余额」口径
    //（/api/stats/credits 那个是收支流水，别混）。
    pool: (() => {
      const list = data.accounts && Array.isArray(data.accounts.accounts) ? data.accounts.accounts : null
      if (!list) return null
      let credits = 0
      let low = 0
      for (const a of list) {
        const c = Number(a && a.credits) || 0
        credits += c
        if (c < 200) low++
      }
      return {
        credits: round2(credits),
        accounts: list.length,
        low,
        synced: Number(data.accounts.pool_synced) || 0,
        available: data.accounts.pool_available !== false,
      }
    })(),
    auth: { role: (data.me && data.me.role) || '', user: (data.me && data.me.username) || '', expiresAt: fmtTs(runtime.cookieExp) },
  }
}

// ─────────────────────── 兜底数据源（网关 /usage） ───────────────────────

// 从 DSH 自己的模型配置里「认出」中转站网关：
//   settings.describe() 会给出每个插件条目的实时 config，模型 provider 的
//   baseURL / apiKeyEnv 就在里面。这样插件不用写死任何域名，装到谁机器上
//   都能顺着他自己配的 provider 干活。
async function detectGateway(ctx) {
  let settings = null
  try {
    settings = ctx.get('settings')
  } catch (err) {
    settings = null
  }
  if (!settings || typeof settings.describe !== 'function') return null

  let descriptors = []
  try {
    descriptors = settings.describe({ redactSecrets: false }) || []
  } catch (err) {
    return null
  }

  // 首选「默认模型」正在用的那个 provider
  let preferred = ''
  for (const d of descriptors) {
    const v = d && d.value
    if (v && typeof v === 'object' && typeof v.provider === 'string' && 'model' in v) {
      preferred = v.provider
      break
    }
  }

  const candidates = []
  for (const d of descriptors) {
    const v = d && d.value
    if (!v || typeof v !== 'object') continue
    const providers = v.providers
    if (!providers || typeof providers !== 'object') continue
    for (const [id, p] of Object.entries(providers)) {
      if (!p || typeof p !== 'object') continue
      const base = typeof p.baseURL === 'string' ? p.baseURL.trim() : ''
      if (!base) continue
      candidates.push({
        provider: id,
        displayName: p.displayName || id,
        baseURL: base.replace(/\/+$/, ''),
        keyRef: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv.trim() : '',
        api: typeof p.api === 'string' ? p.api : '',
      })
    }
  }
  if (!candidates.length) return null

  // 官方 DeepSeek 没有 /usage 这种 key 级接口，跳过
  const isOfficial = (u) => /(^|\.|\/\/)api\.deepseek\.com/i.test(u)
  candidates.sort((a, b) => Number(b.provider === preferred) - Number(a.provider === preferred))

  const creds = (() => {
    try {
      return ctx.get('credentials')
    } catch (err) {
      return null
    }
  })()

  let firstUsable = null
  for (const c of candidates) {
    if (!c.keyRef || isOfficial(c.baseURL)) continue
    if (!firstUsable) firstUsable = c
    let hasKey = false
    try {
      const got = creds && typeof creds.resolve === 'function' ? await creds.resolve(c.keyRef) : null
      hasKey = !!(got && got.value)
    } catch (err) {
      hasKey = false
    }
    if (hasKey) return c
  }
  // 没有凭据也把「候选网关」带出去：界面上能提示「缺少凭据 XXX」，比空着好。
  return firstUsable
}
async function resolveGateway(ctx, cfg) {
  const conf = cfg || loadConfig()
  const url = String(conf.gatewayUrl || '').trim()
  const ref = String(conf.keyRef || '').trim()

  if (url && ref) return { url: url.replace(/\/+$/, ''), ref, source: 'config' }

  if (!runtime.detected) runtime.detected = await detectGateway(ctx)
  const det = runtime.detected
  if (det && !runtime.detectLogged) {
    runtime.detectLogged = true
    console.log(TAG, '自动识别网关：' + (det.displayName || det.provider) + ' → ' + det.baseURL + '（凭据 ' + det.keyRef + '）')
  }

  if (url && det) return { url: url.replace(/\/+$/, ''), ref, source: 'config' }
  if (!url && !ref && det) return { url: det.baseURL, ref: det.keyRef, source: 'detected', provider: det.provider, displayName: det.displayName }
  return null
}

async function resolveGatewayKey(ctx, ref) {
  const name = String(ref || '').trim()
  if (!name) return ''
  try {
    const creds = ctx.get('credentials') || ctx.credentials
    if (creds && typeof creds.resolve === 'function') {
      const got = await creds.resolve(name)
      if (got && got.value) return String(got.value)
    }
  } catch (err) {
    /* 凭据服务不可用时继续 */
  }
  return String(process.env[name] || '')
}

async function collectFallback(ctx, cfg) {
  const conf = cfg || loadConfig()
  const gw = await resolveGateway(ctx, conf)
  if (!gw) {
    throw new Error('没找到可用的中转站网关：请在设置里填「网关地址 + 凭据名」（插件也会自动从 DSH 的模型配置里识别非官方 provider）')
  }

  const key = await resolveGatewayKey(ctx, gw.ref)
  if (!key) throw new Error('缺少凭据 ' + gw.ref + '（可在设置里改「凭据名」）')

  runtime.derivedPrefix = key.slice(0, 12).toLowerCase()
  runtime.lastGateway = gw
  const base = gw.url
  const res = await requestJson(base + '/usage', {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
  })
  if (res.status !== 200 || !res.json) throw new Error('网关 ' + base + '/usage 返回 ' + res.status)

  const j = res.json
  const used = Number(j.credits && j.credits.used) || 0
  const usedTokens = Number(j.tokens && j.tokens.used) || 0
  const day = beijingDay(Date.now())

  if (!runtime.fallbackDay || runtime.fallbackDay.day !== day) {
    runtime.fallbackDay = { day, used }
  }
  const delta = Math.max(0, used - Number(runtime.fallbackDay.used || 0))

  return {
    ok: true,
    mode: 'fallback',
    error: runtime.lastError || '',
    updatedAt: Date.now(),
    stale: false,
    key: {
      name: (j.key && j.key.name) || '未知 key',
      prefix: (j.key && j.key.prefix) || runtime.derivedPrefix,
      usedCredit: round2(used),
      usedTokens,
      quotaCredit: round2(j.credits && j.credits.limit),
      lastUsedAt: fmtTs(j.last_used_at),
    },
    today: { credit: round2(delta), requests: null, promptTokens: null, completionTokens: null },
    panel: null,
    auth: null,
  }
}

// ─────────────────────────── 刷新 ───────────────────────────

async function refresh(ctx, { force = false } = {}) {
  if (runtime.inflight && !force) return runtime.inflight

  const job = (async () => {
    const cfg = loadConfig()
    if (!cfg.enabled) {
      runtime.state = emptyState('config', '已停用')
      return runtime.state
    }

    // 没有面板账号 → 直接走「网关模式」：只要本机有网关凭据就能显示本 key 数据。
    if (!cfg.username || !cfg.secret) {
      try {
        runtime.state = await collectFallback(ctx, cfg)
        runtime.state.error = ''
      } catch (err) {
        runtime.state = emptyState(
          'config',
          String((err && err.message) || err) + '（点设置填凭据名，或补上面板账号解锁全站余额）',
        )
      }
      runtime.state.threshold = computeThreshold(runtime.state, cfg)
      persistState()
      return runtime.state
    }

    const password = await unsealSecret(cfg.secret)
    if (!password) {
      runtime.state = emptyState('config', '面板密码解不开（DPAPI 或文件被改），请重新填写')
      return runtime.state
    }

    try {
      runtime.state = await collectPanel(ctx, cfg, password)
      runtime.lastError = ''
    } catch (err) {
      runtime.lastError = String((err && err.message) || err)
      try {
        runtime.state = await collectFallback(ctx, cfg)
        runtime.state.error = runtime.lastError
      } catch (err2) {
        const msg = runtime.lastError + ' / ' + String((err2 && err2.message) || err2)
        const prev = runtime.state
        runtime.state = prev && prev.ok ? { ...prev, stale: true, error: msg, updatedAt: prev.updatedAt } : emptyState('error', msg)
      }
    }

    runtime.state.threshold = computeThreshold(runtime.state, cfg)
    persistState()
    return runtime.state
  })()

  runtime.inflight = job
  try {
    return await job
  } finally {
    if (runtime.inflight === job) runtime.inflight = null
  }
}

// ─────────────────────────── HTTP 路由 ───────────────────────────

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function passesFence(req) {
  try {
    const host = String(req.headers.host || '')
    let hostname = ''
    try {
      hostname = new URL('http://' + host).hostname
    } catch (err) {
      return false
    }
    if (!isLoopback(hostname)) return false
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      try {
        if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
      } catch (err) {
        return false
      }
    }
    return true
  } catch (err) {
    return false
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let badgeCache = { text: '', mtimeMs: 0 }

function loadBadgeJs() {
  const candidates = [
    path.join(PACKAGE_ROOT, 'assets', 'badge.js'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'badge.js'),
  ]
  for (const file of candidates) {
    try {
      const st = fs.statSync(file)
      if (badgeCache.text && badgeCache.mtimeMs === st.mtimeMs) return badgeCache.text
      const text = fs.readFileSync(file, 'utf8')
      badgeCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) {
      /* 试下一个候选 */
    }
  }
  return badgeCache.text || ''
}

function publicConfig(cfg) {
  const found = findIcon()
  return {
    panelUrl: cfg.panelUrl,
    gatewayUrl: cfg.gatewayUrl,
    keyRef: cfg.keyRef,
    // 自动识别结果（未配置网关时由它兜底），供设置面板显示「已识别到 …」
    detected: runtime.detected
      ? {
          provider: runtime.detected.provider,
          displayName: runtime.detected.displayName,
          gatewayUrl: runtime.detected.baseURL,
          keyRef: runtime.detected.keyRef,
        }
      : null,
    username: cfg.username,
    hasSecret: !!(cfg.secret && cfg.secret.value),
    sealed: !!(cfg.secret && cfg.secret.sealed),
    keyPrefix: cfg.keyPrefix,
    refreshMs: cfg.refreshMs,
    enabled: cfg.enabled,
    thresholds: normalizeThresholds(cfg.thresholds),
    icon: { has: !!found, ext: found ? found.ext : '', version: (cfg.icon && cfg.icon.updatedAt) || 0 },
  }
}

// 状态里带上（脱敏后的）配置，前端设置面板直接读它，不用二次请求。
function withConfig(state) {
  return { ...(state || {}), config: publicConfig(loadConfig()) }
}

function registerRoutes(ctx) {
  const disposers = []

  const handler = async (req, res) => {
    try {
      if (!passesFence(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })

      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname.replace(/\/+$/, '')

      if (p === ROUTE + '/badge.js') {
        const js = loadBadgeJs()
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(js)
        return
      }

      if (p === ROUTE + '/state') {
        if (url.searchParams.get('force') === '1') await refresh(ctx, { force: true })
        const state = runtime.state || (await refresh(ctx))
        return sendJson(res, 200, withConfig(state))
      }

      if (p === ROUTE + '/refresh') {
        const state = await refresh(ctx, { force: true })
        return sendJson(res, 200, withConfig(state))
      }

      if (p === ROUTE + '/icon') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const found = findIcon()
          if (!found) return sendJson(res, 404, { ok: false, error: '还没有设置图标' })
          let buf
          try {
            buf = fs.readFileSync(found.file)
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: '图标读取失败' })
          }
          res.writeHead(200, {
            'Content-Type': found.mime,
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          return res.end(req.method === 'HEAD' ? undefined : buf)
        }

        if (req.method === 'POST') {
          let buf
          try {
            buf = await readRawBody(req, ICON_MAX_BYTES)
          } catch (err) {
            return sendJson(res, 413, { ok: false, error: String((err && err.message) || err) })
          }
          const kind = sniffImage(buf)
          if (!kind) {
            return sendJson(res, 400, { ok: false, error: '只支持 PNG / JPEG / GIF / WebP（按文件头判断，改扩展名无效）' })
          }
          clearIcons()
          try {
            fs.mkdirSync(ICON_DIR, { recursive: true })
            fs.writeFileSync(ICON_BASE + '.' + kind.ext, buf)
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: '写入图标失败：' + ((err && err.message) || err) })
          }
          const saved = loadConfig()
          saved.icon = { ext: kind.ext, updatedAt: Date.now() }
          saveConfig(saved)
          return sendJson(res, 200, { ok: true, config: publicConfig(loadConfig()) })
        }

        if (req.method === 'DELETE') {
          clearIcons()
          const cur = loadConfig()
          cur.icon = null
          saveConfig(cur)
          return sendJson(res, 200, { ok: true, config: publicConfig(loadConfig()) })
        }

        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }

      if (p === ROUTE + '/config') {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: publicConfig(loadConfig()) })

        if (req.method === 'POST') {
          let body = {}
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          }
          const prev = loadConfig()
          const next = { ...prev }
          if (typeof body.panelUrl === 'string' && body.panelUrl.trim()) next.panelUrl = body.panelUrl.trim()
          // 网关两项允许留空＝回到「自动识别」
          if (typeof body.gatewayUrl === 'string') next.gatewayUrl = body.gatewayUrl.trim()
          if (typeof body.keyRef === 'string') next.keyRef = body.keyRef.trim()
          if (typeof body.username === 'string') next.username = body.username.trim()
          if (typeof body.keyPrefix === 'string') next.keyPrefix = body.keyPrefix.trim()
          if (typeof body.enabled === 'boolean') next.enabled = body.enabled
          if (Number(body.refreshMs)) next.refreshMs = Math.max(MIN_REFRESH_MS, Number(body.refreshMs))
          if (body.thresholds && typeof body.thresholds === 'object') {
            next.thresholds = normalizeThresholds({ ...prev.thresholds, ...body.thresholds })
          }
          if (body.clearSecret === true) next.secret = null
          if (typeof body.password === 'string' && body.password) {
            next.secret = await sealSecret(body.password)
          }
          saveConfig(next)
          runtime.cookie = ''
          runtime.cookieExp = 0
          runtime.detected = null
          const state = await refresh(ctx, { force: true })
          return sendJson(res, 200, { ok: true, config: publicConfig(loadConfig()), state: withConfig(state) })
        }

        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      } catch (err2) {
        /* 响应已结束 */
      }
    }
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (err) {}
    }
  }
}

// ─────────────────────────── 注入 ───────────────────────────

const SCRIPT_SRC = ROUTE + '/badge.js'
const BOOT_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + SCRIPT_SRC + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function injectRow(table) {
  try {
    if (!Array.isArray(table)) return
    for (const row of table) {
      if (!row) continue
      if (row.kind === 'script-src' && row.src === SCRIPT_SRC) return
      if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(SCRIPT_SRC) >= 0) return
    }
    table.push({ kind: 'script', placement: 'body', text: BOOT_TEXT })
  } catch (err) {}
}

function injectHtml(html) {
  try {
    if (typeof html !== 'string' || html.indexOf(SCRIPT_SRC) >= 0) return html
    const tag = '<script src="' + SCRIPT_SRC + '" defer></script>'
    if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '</body>')
    return html + tag
  } catch (err) {
    return html
  }
}

// ─────────────────────────── 插件入口 ───────────────────────────

export default {
  name: 'wb-credits',
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch (err) {}
      }
    })

    // ① 注入行注册要立刻做（不依赖任何服务），桌面壳只在启动时收集一次。
    disposers.push(root.on('webserver/index-inject', injectRow))

    // ② 其余逻辑等 webServer / credentials / connection 就绪。
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      loadCachedState()

      disposers.push(registerRoutes(ctx))

      try {
        disposers.push(ctx.webServer.tapIndex(injectHtml))
      } catch (err) {
        console.warn(TAG, 'tapIndex 不可用：' + (err && err.message))
      }

      // 定时刷新：首刷稍作延迟，避免和宿主启动抢资源。
      let stopped = false
      const tick = async () => {
        if (stopped) return
        const cfg = loadConfig()
        try {
          if (cfg.enabled && cfg.username && cfg.secret) await refresh(ctx)
        } catch (err) {
          console.warn(TAG, '刷新失败：' + (err && err.message))
        }
        if (stopped) return
        runtime.timer = setTimeout(tick, cfg.refreshMs)
      }
      runtime.timer = setTimeout(tick, 2500)

      root.effect(() => () => {
        stopped = true
        if (runtime.timer) clearTimeout(runtime.timer)
      })

      console.log(TAG, '已启动，数据文件：' + CONFIG_FILE)
    })
  },
}

// 供本地探针脚本（tools/probe.mjs）驱动，不参与 DSH 运行期。
export const __internals = {
  loadConfig,
  saveConfig,
  sealSecret,
  unsealSecret,
  publicConfig,
  computeThreshold,
  detectGateway,
  resolveGateway,
  findIcon,
  sniffImage,
  refresh,
  runtime,
  CONFIG_FILE,
  CACHE_FILE,
  ICON_DIR,
  ICON_BASE,
}
