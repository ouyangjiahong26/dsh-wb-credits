// 「同学拿到就能用」自测：完全零配置，靠宿主 settings + credentials 自动认出网关。
//
//   node tools/auto-detect-test.mjs
//
// 仿真一台别人的机器：DSH 里配了一个开心中转站 provider（baseURL/apiKeyEnv），
// 凭据服务里有对应 key；插件配置里 gatewayUrl/keyRef 全空。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 隔离 DSH_HOME，别动真实配置。必须在 import 插件之前设好 —— 模块在加载时读 env。
const fakeHome = path.join(os.tmpdir(), 'wb-credits-autodetect-' + Date.now())
process.env.DSH_HOME = fakeHome
fs.mkdirSync(fakeHome, { recursive: true })
fs.writeFileSync(
  path.join(fakeHome, '.dshw-credits.json'),
  JSON.stringify(
    {
      version: 1,
      panelUrl: 'https://relay.example.com',
      gatewayUrl: '',
      keyRef: '',
      username: '',
      secret: null,
      keyPrefix: '',
      enabled: true,
      thresholds: { metric: 'used', warn: 500, alert: 1000 },
    },
    null,
    2,
  ),
)

const { __internals: I } = await import('../lib/index.js')

// 仿真宿主：settings.describe() 里有一个非官方 provider；credentials.resolve() 有 key
const fakeKey = process.env.WB_TEST_KEY || ''
const fakeBase = process.env.WB_TEST_BASE || 'https://relay.example.com/v1'
const services = {
  settings: {
    describe: () => [
      { ns: 'agent-default-model', value: { provider: 'myrelay', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } },
      {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'deepseek-official': { displayName: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
            myrelay: { displayName: '开心中转站', apiKeyEnv: 'MYRELAY_API_KEY', baseURL: fakeBase },
          },
        },
      },
    ],
  },
  credentials: {
    resolve: async (ref) => (ref === 'MYRELAY_API_KEY' && fakeKey ? { value: fakeKey, source: 'test' } : undefined),
  },
}

const ctx = { get: (name) => services[name] }

const det = await I.detectGateway(ctx)
console.log('detectGateway ->', det ? det.provider + ' / ' + det.baseURL + ' / ' + det.keyRef : 'null')

const detectOk = !!det && det.provider === 'myrelay' && det.keyRef === 'MYRELAY_API_KEY' && det.baseURL === fakeBase

if (!fakeKey) {
  console.log('\n(未设 WB_TEST_KEY，只验识别：' + (detectOk ? 'PASS' : 'FAIL') + ')')
  fs.rmSync(fakeHome, { recursive: true, force: true })
  process.exit(detectOk ? 0 : 1)
}

const st = await I.refresh(ctx, { force: true })
console.log('mode      =', st.mode)
console.log('ok        =', st.ok)
console.log('error     =', st.error || '(none)')
console.log('key       =', st.key && st.key.name)
console.log('used      =', st.key && st.key.usedCredit)

fs.rmSync(fakeHome, { recursive: true, force: true })
const ok = st.mode === 'fallback' && st.ok
console.log(ok ? '\nAUTO-DETECT + GATEWAY OK' : '\nFAILED')
process.exit(ok ? 0 : 1)
