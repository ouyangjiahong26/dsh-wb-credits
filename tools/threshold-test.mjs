// 阈值逻辑的边界自测：node tools/threshold-test.mjs
import { __internals as I } from '../lib/index.js'

const st = { key: { usedCredit: 600 }, today: { credit: 120 }, pool: { credits: 800 } }

const cases = [
  ['used 600 / 500-1000', { metric: 'used', warn: 500, alert: 1000 }, 'warn'],
  ['used 600 / 900-300 反序', { metric: 'used', warn: 900, alert: 300 }, 'warn'],
  ['used 600 / 700-1200', { metric: 'used', warn: 700, alert: 1200 }, 'ok'],
  ['used 600 / 300-500', { metric: 'used', warn: 300, alert: 500 }, 'alert'],
  ['today 120 / 100-200', { metric: 'today', warn: 100, alert: 200 }, 'warn'],
  ['pool 800 / 500-1000 反向', { metric: 'pool', warn: 500, alert: 1000 }, 'warn'],
  ['pool 800 / 1000-500 反序', { metric: 'pool', warn: 1000, alert: 500 }, 'warn'],
  ['pool 800 / 100-300', { metric: 'pool', warn: 100, alert: 300 }, 'ok'],
]

let bad = 0
for (const [name, t, want] of cases) {
  const got = I.computeThreshold(st, { thresholds: t }).level
  const ok = got === want
  if (!ok) bad++
  console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(28) + ' got=' + got + ' want=' + want)
}

const missing = I.computeThreshold({ key: null }, { thresholds: { metric: 'used', warn: 1, alert: 2 } })
console.log('缺数据 level=' + missing.level + ' value=' + missing.value)

console.log(bad === 0 ? '\nALL PASS' : '\n' + bad + ' FAILED')
process.exit(bad === 0 ? 0 : 1)
