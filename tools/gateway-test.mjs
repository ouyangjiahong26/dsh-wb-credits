// 网关模式自测：没有任何面板账号，仅靠「网关地址 + 本机凭据」出数。
//
//   $env:DSH_HOME = '<临时目录>'
//   $env:CISLUNAR_API_KEY = 'wbk_...'
//   node tools/gateway-test.mjs
//
// 会写一份不含 username/secret 的配置，然后走 A 档采集。

import fs from 'node:fs'
import path from 'node:path'
import { __internals as I } from '../lib/index.js'

const cfgPath = I.CONFIG_FILE
fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      version: 1,
      panelUrl: 'https://pm.cislunarspace.cn',
      gatewayUrl: 'https://api.cislunarspace.cn/v1',
      keyRef: 'CISLUNAR_API_KEY',
      username: '',
      secret: null,
      keyPrefix: '',
      refreshMs: 300000,
      enabled: true,
      thresholds: { metric: 'today', warn: 100, alert: 200 },
      icon: null,
    },
    null,
    2,
  ),
)

const ctx = { get: () => undefined }
const st = await I.refresh(ctx, { force: true })

console.log('mode      =', st.mode)
console.log('ok        =', st.ok)
console.log('error     =', st.error || '(none)')
console.log('key       =', st.key && st.key.name, '/', st.key && st.key.prefix)
console.log('used      =', st.key && st.key.usedCredit)
console.log('today     =', st.today && st.today.credit)
console.log('pool      =', st.pool ? st.pool.credits : '(无面板，符合预期)')
console.log('threshold =', st.threshold && st.threshold.metric, st.threshold && st.threshold.level)

const okMode = st.mode === 'fallback' && st.ok
console.log(okMode ? '\nGATEWAY MODE OK' : '\nGATEWAY MODE FAILED')
process.exit(okMode ? 0 : 1)
