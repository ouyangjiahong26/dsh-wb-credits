// 本地探针：不开 DSH，直接驱动 host 端的采集逻辑，验证登录 / 取数 / 落盘。
//
//   node tools/probe.mjs <username> <password> [keyPrefix]
//
// 会真实写入 $DSH_HOME/.dshw-credits.json（密码 DPAPI 加密）。

import { __internals as I } from '../lib/index.js'

const [username, password, keyPrefix = ''] = process.argv.slice(2)
if (!username || !password) {
  console.error('用法：node tools/probe.mjs <username> <password> [keyPrefix]')
  process.exit(2)
}

const ctx = {
  get() {
    return undefined
  },
  credentials: undefined,
}

console.log('[1] 加密密码…')
const secret = await I.sealSecret(password)
console.log('    sealed =', secret && secret.sealed)

console.log('[2] 解密回读…')
const back = await I.unsealSecret(secret)
console.log('    回读一致 =', back === password)

console.log('[3] 写入配置…')
I.saveConfig({ panelUrl: 'https://pm.cislunarspace.cn', username, secret, keyPrefix })
console.log('    config =', I.CONFIG_FILE)

console.log('[4] 采集…')
const state = await I.refresh(ctx, { force: true })
console.log(JSON.stringify(state, null, 2))

if (!state.ok) {
  console.error('\n采集失败，退出码 1')
  process.exit(1)
}
console.log('\nOK')
