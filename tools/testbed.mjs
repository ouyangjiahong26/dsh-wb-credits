// 本地试车台：不开 DSH，用最小 HTML 壳把 badge.js 跑起来，方便截屏验收。
//
//   node tools/testbed.mjs [port]
//
// 提供：
//   GET  /                        → 极简页面壳（可加 ?theme=dark）
//   GET  /dsh-wb-credits/badge.js → assets/badge.js
//   GET  /dsh-wb-credits/state    → 真实采集结果（走 __internals.refresh）
//   POST /dsh-wb-credits/refresh  → 强制重采
//
// 调试锚点：#wbcr-expand 直接展开面板，#wbcr-settings 展开设置。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __internals as I } from '../lib/index.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 8731)

const ctx = { get: () => undefined }

let cached = null

async function state(force) {
  if (cached && !force) return cached
  cached = await I.refresh(ctx, { force: true })
  return cached
}

function withConfig(s) {
  return { ...(s || {}), config: I.publicConfig(I.loadConfig()) }
}

const HTML = (dark) => `<!doctype html>
<html lang="zh-CN" data-theme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<title>badge testbed</title>
<style>
  :root{
    --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#f6f7f9;--dsw-alias-bg-layer-2:#eceef2;
    --dsw-alias-bg-overlay:#ffffff;--dsw-alias-border-l1:#e3e5e8;--dsw-alias-border-l2:#cfd2d6;
    --dsw-alias-brand-primary:#4d6bfe;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#6b7280;
    --dsw-alias-state-error-primary:#ef4444;--dsw-alias-state-idle-primary:#9aa0a6;
    --dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-primary:#f59e0b;
  }
  [data-theme="dark"]{
    --dsw-alias-bg-base:#14151a;--dsw-alias-bg-layer-1:#1b1d23;--dsw-alias-bg-layer-2:#23252c;
    --dsw-alias-bg-overlay:#1e2027;--dsw-alias-border-l1:#2c2f37;--dsw-alias-border-l2:#3a3e47;
    --dsw-alias-label-primary:#e8eaed;--dsw-alias-label-secondary:#9aa0a6;
  }
  body{margin:0;height:100vh;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
    font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .fake{position:fixed;left:40px;top:28px;opacity:.45;font-size:12px}
  .whale{margin:70px 24px;background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:18px 22px;width:300px;font-size:13px}
</style>
</head>
<body>
  <div class="fake">testbed · theme=${dark ? 'dark' : 'light'}</div>
  <div class="whale">（这里假装是小蓝鲸的占位区）</div>
<script src="/dsh-wb-credits/badge.js"></script>
</body>
</html>`

function sendJson(res, payload, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/') {
    const dark = url.searchParams.get('theme') === 'dark'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(HTML(dark))
  }

  if (p === '/dsh-wb-credits/badge.js') {
    const js = fs.readFileSync(path.join(PACKAGE_ROOT, 'assets', 'badge.js'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(js)
  }

  if (p === '/dsh-wb-credits/state' || p === '/dsh-wb-credits/refresh') {
    try {
      const s = await state(p.endsWith('refresh') || url.searchParams.get('force') === '1')
      return sendJson(res, withConfig(s))
    } catch (err) {
      return sendJson(res, { ok: false, mode: 'error', error: String(err && err.message) }, 500)
    }
  }

  if (p === '/dsh-wb-credits/icon') {
    if (req.method === 'GET') {
      const found = I.findIcon()
      if (!found) return sendJson(res, { ok: false, error: 'no icon' }, 404)
      const buf = fs.readFileSync(found.file)
      res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'no-store' })
      return res.end(buf)
    }
    if (req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const buf = Buffer.concat(chunks)
      const kind = I.sniffImage(buf)
      if (!kind) return sendJson(res, { ok: false, error: '不是有效图片' }, 400)
      fs.mkdirSync(I.ICON_DIR, { recursive: true })
      fs.writeFileSync(I.ICON_BASE + '.' + kind.ext, buf)
      const cfg = I.loadConfig()
      cfg.icon = { ext: kind.ext, updatedAt: Date.now() }
      I.saveConfig(cfg)
      cached = null
      return sendJson(res, { ok: true, config: I.publicConfig(I.loadConfig()) })
    }
    if (req.method === 'DELETE') {
      for (const ext of ['png', 'jpg', 'gif', 'webp']) {
        const f = I.ICON_BASE + '.' + ext
        if (fs.existsSync(f)) fs.unlinkSync(f)
      }
      const cfg = I.loadConfig()
      cfg.icon = null
      I.saveConfig(cfg)
      cached = null
      return sendJson(res, { ok: true, config: I.publicConfig(I.loadConfig()) })
    }
  }

  if (p === '/dsh-wb-credits/config' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch (err) {}
    const cfg = I.loadConfig()
    if (body.thresholds) cfg.thresholds = body.thresholds
    I.saveConfig(cfg)
    cached = null
    const s = await state(true)
    return sendJson(res, { ok: true, config: I.publicConfig(I.loadConfig()), state: withConfig(s) })
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('testbed: http://127.0.0.1:' + PORT + '/')
  console.log('dark:    http://127.0.0.1:' + PORT + '/?theme=dark')
})
