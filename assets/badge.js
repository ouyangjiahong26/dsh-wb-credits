// dsh-wb-credits —— 浏览器端小挂件
//
// 由 host 端注入到页面（<script src="/dsh-wb-credits/badge.js">）。
// 只读 host 的 /dsh-wb-credits/state 与 /icon，不直接碰任何外部接口（密钥/密码都在 host）。

;(function () {
  if (window.__DSH_WB_CREDITS__) return
  window.__DSH_WB_CREDITS__ = true

  var BASE = '/dsh-wb-credits'
  var POS_KEY = 'dsh-wb-credits:pos'
  var POLL_MS = 60 * 1000

  var state = null
  var expanded = location.hash.indexOf('wbcr-expand') >= 0
  var settingsOpen = location.hash.indexOf('wbcr-settings') >= 0
  var busy = false
  var lastError = ''
  var mounted = false
  var rootEl = null
  var pollTimer = null
  var dragged = false

  // ────────────────────────── 工具 ──────────────────────────

  function num(n) {
    var v = Number(n)
    return isFinite(v) ? v : null
  }

  function fmtCredit(n) {
    var v = num(n)
    if (v === null) return '—'
    return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  function fmtInt(n) {
    var v = num(n)
    if (v === null) return '—'
    return v.toLocaleString('zh-CN')
  }

  function fmtTime(iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    var p = function (x) {
      return x < 10 ? '0' + x : '' + x
    }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function ago(ms) {
    var v = num(ms)
    if (v === null || v <= 0) return '—'
    var s = Math.max(0, Math.round((Date.now() - v) / 1000))
    if (s < 60) return s + ' 秒前'
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
    return Math.floor(s / 86400) + ' 天前'
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function pos() {
    var raw = null
    try {
      raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    } catch (e) {
      raw = null
    }
    if (raw && isFinite(raw.right) && isFinite(raw.bottom)) return raw
    // 默认贴右下角（小蓝鲸原来待的位置，它已停用）
    return { right: 18, bottom: 18 }
  }

  function savePos(p) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p))
    } catch (e) {}
  }

  function applyPos(p) {
    if (!rootEl) return
    rootEl.style.right = Math.max(0, p.right) + 'px'
    rootEl.style.bottom = Math.max(0, p.bottom) + 'px'
  }

  // 状态色：error > 阈值红 > 阈值黄 > 正常
  function level() {
    if (!state) return ''
    if (state.mode === 'error') return 'alert'
    if (state.threshold && state.threshold.level) {
      if (state.threshold.level === 'alert') return 'alert'
      if (state.threshold.level === 'warn') return 'warn'
    }
    return ''
  }

  function toneClass() {
    var lv = level()
    if (lv === 'alert') return 'err'
    if (lv === 'warn') return 'warn'
    if (state && (state.mode === 'config' || state.stale)) return 'warn'
    return 'ok'
  }

  function cfg() {
    return (state && state.config) || {}
  }

  // ────────────────────────── 样式 ──────────────────────────

  var CSS = [
    '.wbcr-root{position:fixed;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2328);user-select:none;',
    '-webkit-user-select:none;animation:wbcr-in .18s ease-out}',
    '@keyframes wbcr-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '.wbcr-pill{display:flex;align-items:center;gap:9px;padding:7px 12px 7px 9px;border-radius:16px;cursor:pointer;',
    'background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.94));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
    'box-shadow:0 4px 16px rgba(0,0,0,.10);backdrop-filter:blur(10px);transition:box-shadow .15s,transform .15s}',
    '.wbcr-pill:hover{box-shadow:0 6px 22px rgba(0,0,0,.16);transform:translateY(-1px)}',
    '.wbcr-pill.err{border-color:var(--dsw-alias-state-error-primary,#ef4444)}',
    '.wbcr-pill.warn{border-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.wbcr-dot{width:8px;height:8px;border-radius:50%;flex:none;margin:0 4px;background:var(--dsw-alias-state-idle-primary,#9aa0a6)}',
    '.wbcr-dot.ok{background:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.wbcr-dot.warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.wbcr-dot.err{background:var(--dsw-alias-state-error-primary,#ef4444)}',
    '.wbcr-av{width:26px;height:26px;border-radius:9px;object-fit:cover;flex:none;',
    'border:1.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#f6f7f9);display:block}',
    '.wbcr-av.ok{border-color:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.wbcr-av.warn{border-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.wbcr-av.err{border-color:var(--dsw-alias-state-error-primary,#ef4444)}',
    '.wbcr-col{display:flex;flex-direction:column;min-width:0}',
    '.wbcr-l1{display:flex;align-items:baseline;white-space:nowrap}',
    '.wbcr-num{font-size:14px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums}',
    '.wbcr-cap{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);margin-right:4px}',
    '.wbcr-unit{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);margin-left:3px}',
    '.wbcr-sub{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:1px;white-space:nowrap}',
    '.wbcr-tag{font-size:9px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));',
    'color:var(--dsw-alias-label-secondary,#6b7280);margin-left:5px;vertical-align:middle}',
    '.wbcr-panel{position:relative;width:276px;margin-bottom:8px;padding:12px 13px;border-radius:15px;overflow-y:auto;',
    'overscroll-behavior:contain;scrollbar-width:thin;',
    'background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.96));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
    'box-shadow:0 10px 34px rgba(0,0,0,.16);backdrop-filter:blur(12px)}',
    '.wbcr-title{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;',
    'color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:8px;letter-spacing:.02em}',
    '.wbcr-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0}',
    '.wbcr-k{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);flex:none}',
    '.wbcr-v{font-size:11px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbcr-v b{font-weight:650}',
    '.wbcr-v.hot{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.wbcr-v.crit{color:var(--dsw-alias-state-error-primary,#ef4444)}',
    '.wbcr-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.07));margin:8px 0}',
    '.wbcr-actions{display:flex;gap:6px;margin-top:10px}',
    '.wbcr-btn{flex:1;padding:5px 0;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
    'background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:11px;cursor:pointer;transition:background .12s}',
    '.wbcr-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}',
    '.wbcr-btn.primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}',
    '.wbcr-btn.primary:hover{filter:brightness(1.06)}',
    '.wbcr-btn[disabled]{opacity:.5;cursor:default}',
    '.wbcr-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}',
    '.wbcr-field label{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.wbcr-field input,.wbcr-field select{padding:5px 8px;border-radius:8px;font-size:11px;font-family:inherit;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,transparent);',
    'color:var(--dsw-alias-label-primary,#1f2328);outline:none}',
    '.wbcr-field input:focus,.wbcr-field select:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
    '.wbcr-two{display:flex;gap:6px}',
    '.wbcr-two .wbcr-field{flex:1}',
    '.wbcr-hint{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:-2px;line-height:1.5}',
    '.wbcr-err{font-size:10px;color:var(--dsw-alias-state-error-primary,#ef4444);margin-top:6px;line-height:1.5;word-break:break-all}',
    '.wbcr-iconline{display:flex;align-items:center;gap:9px;margin-bottom:8px}',
    '.wbcr-iconline img,.wbcr-iconline .wbcr-ph{width:34px;height:34px;border-radius:10px;object-fit:cover;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#f6f7f9)}',
    '.wbcr-iconline .wbcr-ph{display:flex;align-items:center;justify-content:center;font-size:9px;',
    'color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.wbcr-iconbtns{display:flex;gap:6px;flex:1}',
    '.wbcr-section{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);',
    'margin:10px 0 6px;letter-spacing:.04em}',
  ].join('')

  function injectStyle() {
    if (document.getElementById('wbcr-style')) return
    var s = document.createElement('style')
    s.id = 'wbcr-style'
    s.textContent = CSS
    ;(document.head || document.documentElement).appendChild(s)
  }

  // ────────────────────────── 数据 ──────────────────────────

  function fetchState(force) {
    var url = BASE + '/state' + (force ? '?force=1' : '')
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (j) {
        if (j && j.ok !== undefined) {
          state = j
          lastError = j.error || ''
        }
        return state
      })
  }

  function postJson(path, body) {
    return fetch(BASE + path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json()
    })
  }

  function iconUrl() {
    var v = (cfg().icon && cfg().icon.version) || 0
    return BASE + '/icon?v=' + v
  }

  function hasIcon() {
    return !!(cfg().icon && cfg().icon.has)
  }

  // ────────────────────────── 渲染：胶囊 ──────────────────────────

  function renderAvatar() {
    var t = toneClass()
    if (hasIcon()) {
      var img = el('img', 'wbcr-av ' + t)
      img.src = iconUrl()
      img.alt = ''
      img.draggable = false
      return img
    }
    return el('span', 'wbcr-dot ' + t)
  }

  function renderPill() {
    var lv = level()
    var pill = el('div', 'wbcr-pill' + (lv === 'alert' ? ' err' : lv === 'warn' ? ' warn' : ''))

    pill.appendChild(renderAvatar())

    var col = el('div', 'wbcr-col')
    var line1 = el('div', 'wbcr-l1')
    var line2 = el('div', 'wbcr-sub')
    var line3 = el('div', 'wbcr-sub')

    if (!state || state.mode === 'config') {
      line1.innerHTML = '<span class="wbcr-num">未配置</span>'
      line2.textContent = '点我填面板账号'
      line3.style.display = 'none'
    } else if (state.mode === 'error') {
      line1.innerHTML = '<span class="wbcr-num">同步失败</span>'
      line2.textContent = '点开看详情'
      line3.style.display = 'none'
    } else {
      var used = state.key ? state.key.usedCredit : null
      line1.innerHTML =
        '<span class="wbcr-cap">已用</span>' +
        '<span class="wbcr-num">' + fmtCredit(used) + '</span>' +
        '<span class="wbcr-unit">积分</span>'
      if (state.mode === 'fallback') line1.appendChild(el('span', 'wbcr-tag', '网关'))

      var today = state.today || {}
      var bits = ['今日 ' + fmtCredit(today.credit)]
      if (today.requests != null) bits.push(fmtInt(today.requests) + ' 次')
      line2.textContent = bits.join(' · ')

      if (state.pool && state.pool.credits != null) {
        line3.textContent = '全站 ' + fmtCredit(state.pool.credits) + ' 积分'
      } else {
        line3.style.display = 'none'
      }
    }

    col.appendChild(line1)
    col.appendChild(line2)
    col.appendChild(line3)
    pill.appendChild(col)

    pill.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      startDrag(e, pill)
    })

    pill.addEventListener('click', function (e) {
      if (dragged) {
        dragged = false
        return
      }
      e.stopPropagation()
      var willOpen = !expanded
      expanded = willOpen
      settingsOpen = false
      render()
      if (willOpen) {
        fetchState(true)
          .then(function () {
            render()
          })
          .catch(function () {})
      }
    })

    return pill
  }

  // ────────────────────────── 渲染：面板 ──────────────────────────

  function row(k, v, opts) {
    var o = opts || {}
    var r = el('div', 'wbcr-row')
    r.appendChild(el('span', 'wbcr-k', k))
    var val = el('span', 'wbcr-v' + (o.crit ? ' crit' : o.hot ? ' hot' : ''))
    if (o.bold) val.appendChild(el('b', null, v))
    else val.textContent = v
    r.appendChild(val)
    return r
  }

  function fmtTh(n) {
    var v = num(n)
    if (v === null) return '—'
    return Number.isInteger(v) ? v.toLocaleString('zh-CN') : fmtCredit(v)
  }

  function thresholdLabel(t) {
    if (!t) return '—'
    var name = t.metric === 'pool' ? '全站余额' : t.metric === 'today' ? '本 key 今日' : '本 key 已用'
    var sign = t.metric === 'pool' ? '≤' : '≥'
    return name + ' ' + sign + fmtTh(t.warn) + ' 黄 / ' + sign + fmtTh(t.alert) + ' 红'
  }

  function renderPanel() {
    var box = el('div', 'wbcr-panel')

    var p = pos()
    var avail = window.innerHeight - p.bottom - 108
    box.style.maxHeight = Math.max(150, Math.min(avail, 500)) + 'px'

    var title = el('div', 'wbcr-title')
    title.appendChild(el('span', null, '中转站积分'))
    title.appendChild(el('span', null, state && state.mode === 'fallback' ? '网关兜底' : ''))
    box.appendChild(title)

    if (!state || state.mode === 'config' || state.mode === 'error') {
      box.appendChild(el('div', 'wbcr-hint', (state && state.error) || '还没连上面板'))
      if (state && state.key) {
        box.appendChild(row('当前 key', state.key.name + ' / ' + state.key.prefix))
        box.appendChild(row('已用', fmtCredit(state.key.usedCredit) + ' 积分', { bold: true }))
      }
    } else {
      var k = state.key || {}
      var t = state.today || {}
      var pl = state.panel
      var pool = state.pool
      var th = state.threshold

      box.appendChild(row('Key', k.name))
      box.appendChild(row('已用积分', fmtCredit(k.usedCredit), { bold: true }))
      box.appendChild(
        row(
          '今日消耗',
          fmtCredit(t.credit) + (t.requests != null ? ' · ' + fmtInt(t.requests) + ' 次' : ''),
          { bold: true },
        ),
      )

      if (pool) {
        box.appendChild(el('div', 'wbcr-sep'))
        box.appendChild(
          row('全站积分余额', fmtCredit(pool.credits), {
            bold: true,
            hot: !!(th && th.metric === 'pool' && th.level === 'warn'),
            crit: !!(th && th.metric === 'pool' && th.level === 'alert'),
          }),
        )
        box.appendChild(
          row('账号数', fmtInt(pool.accounts) + (pool.low ? ' · ' + pool.low + ' 个低于 200' : '')),
        )
      }

      if (pl) {
        box.appendChild(row('全站今日', fmtCredit(pl.todayCredit) + ' · ' + fmtInt(pl.todayRequests) + ' 次'))
        box.appendChild(row('本周全站', fmtCredit(pl.weekCredit)))
      }

      box.appendChild(el('div', 'wbcr-sep'))
      box.appendChild(row('Tokens', fmtInt(k.usedTokens)))
      box.appendChild(row('最后调用', fmtTime(k.lastUsedAt)))

      if (th) {
        var cur = th.value == null ? '—' : fmtCredit(th.value)
        box.appendChild(row('阈值', thresholdLabel(th)))
        box.appendChild(
          row(
            '当前口径',
            cur + (th.level === 'alert' ? ' · 已超红线' : th.level === 'warn' ? ' · 已超黄线' : ' · 正常'),
            { hot: th.level === 'warn', crit: th.level === 'alert' },
          ),
        )
      }

      if (state.auth && state.auth.role) {
        box.appendChild(row('面板会话', state.auth.role + ' · 至 ' + fmtTime(state.auth.expiresAt)))
      }

      box.appendChild(row('同步于', ago(state.updatedAt)))
      if (state.error) box.appendChild(el('div', 'wbcr-err', state.error))
    }

    var actions = el('div', 'wbcr-actions')
    var btnRefresh = el('button', 'wbcr-btn primary', busy ? '刷新中…' : '刷新')
    btnRefresh.disabled = busy
    btnRefresh.addEventListener('click', function (e) {
      e.stopPropagation()
      doRefresh()
    })
    var btnSettings = el('button', 'wbcr-btn', settingsOpen ? '收起设置' : '设置')
    btnSettings.addEventListener('click', function (e) {
      e.stopPropagation()
      settingsOpen = !settingsOpen
      render()
    })
    actions.appendChild(btnRefresh)
    actions.appendChild(btnSettings)
    box.appendChild(actions)

    if (settingsOpen) box.appendChild(renderSettings())

    box.addEventListener('click', function (e) {
      e.stopPropagation()
    })

    return box
  }

  // ────────────────────────── 渲染：设置 ──────────────────────────

  function field(label, value, type, placeholder) {
    var wrap = el('div', 'wbcr-field')
    wrap.appendChild(el('label', null, label))
    var input = el('input')
    input.type = type || 'text'
    input.value = value == null ? '' : value
    input.spellcheck = false
    if (placeholder) input.placeholder = placeholder
    wrap.appendChild(input)
    return { wrap: wrap, input: input }
  }

  function thresholdSelect(value) {
    var wrap = el('div', 'wbcr-field')
    wrap.appendChild(el('label', null, '阈值口径'))
    var sel = el('select')
    ;[
      ['used', '本 key 累计已用'],
      ['today', '本 key 今日已用'],
      ['pool', '全站积分余额（低于阈值告警）'],
    ].forEach(function (opt) {
      var o = el('option', null, opt[1])
      o.value = opt[0]
      if (value === opt[0]) o.selected = true
      sel.appendChild(o)
    })
    wrap.appendChild(sel)
    return { wrap: wrap, input: sel }
  }

  function renderIconRow() {
    var wrap = el('div')
    wrap.appendChild(el('div', 'wbcr-section', '图标'))

    var line = el('div', 'wbcr-iconline')
    if (hasIcon()) {
      var img = el('img')
      img.src = iconUrl()
      img.alt = ''
      line.appendChild(img)
    } else {
      line.appendChild(el('div', 'wbcr-ph', '默认'))
    }

    var btns = el('div', 'wbcr-iconbtns')
    var pick = el('button', 'wbcr-btn', hasIcon() ? '换一张' : '选图片')
    pick.addEventListener('click', function (e) {
      e.stopPropagation()
      pickIcon()
    })
    btns.appendChild(pick)
    if (hasIcon()) {
      var del = el('button', 'wbcr-btn', '移除')
      del.addEventListener('click', function (e) {
        e.stopPropagation()
        removeIcon()
      })
      btns.appendChild(del)
    }
    line.appendChild(btns)
    wrap.appendChild(line)
    wrap.appendChild(el('div', 'wbcr-hint', 'PNG / JPEG / GIF / WebP，≤2 MB；存在 $DSH_HOME\\wb-credits。'))
    return wrap
  }

  function renderSettings() {
    var wrap = el('div', 'wbcr-settings')
    var c = cfg()

    wrap.appendChild(el('div', 'wbcr-section', '网关（留空＝自动识别）'))

    var det = c.detected
    var fGw = field('网关地址', c.gatewayUrl || '', 'text', det ? det.gatewayUrl : 'https://your-relay.example.com/v1')
    var fRef = field('凭据名', c.keyRef || '', 'text', det ? det.keyRef : 'YOUR_API_KEY')
    ;[fGw, fRef].forEach(function (f) {
      wrap.appendChild(f.wrap)
    })
    wrap.appendChild(
      el(
        'div',
        'wbcr-hint',
        det
          ? '已自动识别：' + (det.displayName || det.provider) + ' → ' + det.gatewayUrl + '（凭据 ' + det.keyRef + '）'
          : '没能自动识别。填「网关地址 + 凭据名」即可：插件请求 {网关地址}/usage 读本 key 已用积分。',
      ),
    )

    wrap.appendChild(el('div', 'wbcr-section', '面板（可选，用来解锁全站余额）'))

    var fUrl = field('面板地址', c.panelUrl || 'https://pm.cislunarspace.cn')
    var fUser = field('只读账号（留空＝只看本 key）', c.username || '')
    var fPass = field('密码（留空表示不改）', '', 'password', '不修改就留空')
    var fPrefix = field('Key 前缀（留空＝自动取在用那把）', c.keyPrefix || '')
    ;[fUrl, fUser, fPass, fPrefix].forEach(function (f) {
      wrap.appendChild(f.wrap)
    })

    wrap.appendChild(el('div', 'wbcr-section', '阈值提醒'))
    var th = c.thresholds || { metric: 'used', warn: 500, alert: 1000 }
    var fMetric = thresholdSelect(th.metric)
    wrap.appendChild(fMetric.wrap)

    var two = el('div', 'wbcr-two')
    var fWarn = field('黄线', th.warn)
    fWarn.input.type = 'number'
    var fAlert = field('红线', th.alert)
    fAlert.input.type = 'number'
    two.appendChild(fWarn.wrap)
    two.appendChild(fAlert.wrap)
    wrap.appendChild(two)
    wrap.appendChild(
      el('div', 'wbcr-hint', '超过黄线胶囊变黄、超过红线变红；「全站余额」口径方向相反（低于阈值告警）。'),
    )

    wrap.appendChild(renderIconRow())

    if (lastError) wrap.appendChild(el('div', 'wbcr-err', lastError))

    var actions = el('div', 'wbcr-actions')
    var save = el('button', 'wbcr-btn primary', busy ? '保存中…' : '保存并重连')
    save.disabled = busy
    save.addEventListener('click', function (e) {
      e.stopPropagation()
      var body = {
        panelUrl: fUrl.input.value.trim(),
        gatewayUrl: fGw.input.value.trim(),
        keyRef: fRef.input.value.trim(),
        username: fUser.input.value.trim(),
        keyPrefix: fPrefix.input.value.trim(),
        thresholds: {
          metric: fMetric.input.value,
          warn: Number(fWarn.input.value),
          alert: Number(fAlert.input.value),
        },
      }
      if (fPass.input.value) body.password = fPass.input.value
      busy = true
      render()
      postJson('/config', body)
        .then(function (j) {
          if (j && j.state) state = j.state
          busy = false
          settingsOpen = false
          lastError = (j && j.state && j.state.error) || ''
          render()
        })
        .catch(function (err) {
          busy = false
          lastError = String((err && err.message) || err)
          render()
        })
    })
    actions.appendChild(save)
    wrap.appendChild(actions)

    return wrap
  }

  // ────────────────────────── 图标上传 ──────────────────────────

  function pickIcon() {
    var input = document.getElementById('wbcr-file')
    if (!input) {
      input = document.createElement('input')
      input.type = 'file'
      input.id = 'wbcr-file'
      input.accept = 'image/png,image/jpeg,image/gif,image/webp'
      input.style.display = 'none'
      input.addEventListener('change', function () {
        var f = input.files && input.files[0]
        input.value = ''
        if (f) uploadIcon(f)
      })
      document.body.appendChild(input)
    }
    input.click()
  }

  function uploadIcon(file) {
    if (file.size > 2 * 1024 * 1024) {
      lastError = '图片超过 2 MB'
      render()
      return
    }
    var reader = new FileReader()
    reader.onload = function () {
      busy = true
      render()
      fetch(BASE + '/icon', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: reader.result,
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (j) {
          busy = false
          if (!j || !j.ok) {
            lastError = (j && j.error) || '上传失败'
            render()
            return
          }
          lastError = ''
          return fetchState(false).then(render)
        })
        .catch(function (err) {
          busy = false
          lastError = String((err && err.message) || err)
          render()
        })
    }
    reader.onerror = function () {
      lastError = '读取图片失败'
      render()
    }
    reader.readAsArrayBuffer(file)
  }

  function removeIcon() {
    busy = true
    render()
    fetch(BASE + '/icon', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function () {
        busy = false
        lastError = ''
        return fetchState(false).then(render)
      })
      .catch(function (err) {
        busy = false
        lastError = String((err && err.message) || err)
        render()
      })
  }

  // ────────────────────────── 整体渲染 ──────────────────────────

  function render() {
    if (!mounted) return
    var p = pos()
    rootEl.innerHTML = ''
    applyPos(p)

    var wrap = el('div')
    if (expanded) wrap.appendChild(renderPanel())
    wrap.appendChild(renderPill())
    rootEl.appendChild(wrap)

    if (expanded && settingsOpen) {
      var box = rootEl.querySelector('.wbcr-panel')
      var sett = rootEl.querySelector('.wbcr-settings')
      if (box && sett) box.scrollTop = Math.max(0, sett.offsetTop - 30)
    }
  }

  function doRefresh() {
    busy = true
    render()
    postJson('/refresh')
      .then(function (j) {
        if (j) state = j
        busy = false
        lastError = (j && j.error) || ''
        render()
      })
      .catch(function (err) {
        busy = false
        lastError = String((err && err.message) || err)
        render()
      })
  }

  // ────────────────────────── 拖拽 ──────────────────────────

  function startDrag(e, handle) {
    var start = pos()
    var x0 = e.clientX
    var y0 = e.clientY
    var moved = false
    dragged = false

    function onMove(ev) {
      var dx = x0 - ev.clientX
      var dy = y0 - ev.clientY
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true
      if (!moved) return
      dragged = true
      var next = {
        right: Math.max(0, Math.min(window.innerWidth - 80, start.right + dx)),
        bottom: Math.max(0, Math.min(window.innerHeight - 40, start.bottom + dy)),
      }
      applyPos(next)
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (moved) {
        savePos({
          right: parseFloat(rootEl.style.right) || start.right,
          bottom: parseFloat(rootEl.style.bottom) || start.bottom,
        })
      }
      setTimeout(function () {
        dragged = false
      }, 0)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    e.preventDefault()
  }

  // ────────────────────────── 挂载 ──────────────────────────

  function mount() {
    if (mounted) return
    if (!document.body) return
    injectStyle()
    rootEl = el('div', 'wbcr-root')
    rootEl.id = 'wbcr-root'
    applyPos(pos())
    document.body.appendChild(rootEl)
    mounted = true
    render()
  }

  function poll() {
    fetchState(false)
      .then(function () {
        if (mounted) render()
      })
      .catch(function () {})
  }

  function boot() {
    mount()
    poll()
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
