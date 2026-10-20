# dsh-wb-credits

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）Web 界面加一枚**中转站积分胶囊**，常驻右下角：

![胶囊](docs/shot-light.png)

- 🪙 **本 key 已用积分** · **今日消耗 + 请求数** · **全站积分余额**（账号池口径）
- 🎨 **自定义图标**：换成自己的图，状态色描边跟着阈值走
- 🚦 **阈值提醒**：超黄线变黄、超红线变红，口径可切（本 key 累计 / 本 key 今日 / 全站余额）
- 🔍 **网关自动识别**：不用填域名，插件从 DSH 自己的模型 provider 配置里认出你在用的中转站
- 🔒 **只读**：只发 GET 统计接口 + 一个 `POST /api/login`，不碰充值、账号、签到

## 安装

### 方式一：一条命令（推荐）

```
dsh plugin --profile web add github:zhanghongfeix/dsh-wb-credits
```

或在本机 DSH 的「设置 → 插件」里，把 `github:zhanghongfeix/dsh-wb-credits` 填进安装框。

### 方式二：下载 zip 手动装（不需要 npm / 网络包管理器）

1. 下载本仓库（Code → Download ZIP）并解压
2. 双击 `install.cmd`（或 `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`）
3. 脚本会自己找到 DSH profile、装到 `node_modules`、往 `cordis.patch.yml` 追加条目（改动前自动备份）

装完**重启一次 DSH Desktop**，打开会话页就能看到胶囊。

## 首次使用：通常什么都不用配

插件会读 DSH 的模型 provider 配置（`settings.describe()`），挑一个**非官方 `api.deepseek.com`、且本机有凭据**的 provider 当网关，然后用它调 `GET {baseURL}/usage`。

本机实测日志：

```
[dsh-wb-credits] 自动识别网关：Cislunar → https://<你的中转站>/v1（凭据 YOUR_API_KEY）
```

识别不到时（比如 provider 名不标准），点胶囊 →「设置」，填两项即可：**网关地址** + **凭据名**。

> **凭据名**是 DSH 凭据里的键名（例如 `MYRELAY_API_KEY`），不是 key 本身 —— 插件通过宿主的 credentials 服务取值，README 和配置文件里都不会出现明文密钥。

### 想要「全站积分余额」

这个数来自中转站面板（运营侧口径：所有 WorkBuddy 账号的 `credits` 之和），需要一个**只读面板账号**：

设置 → 面板 → 填面板地址 / 只读账号 / 密码。密码用 **Windows DPAPI** 加密后存在 `$DSH_HOME`，拷到别的机器解不开。

不填也能用，只是少了「全站余额」这一行。

## 支持的网关协议

目前适配的是 **workbuddy2api 风格**的 key 级用量接口：

```http
GET {baseURL}/usage
Authorization: Bearer <key>
```

```json
{ "key": { "name": "飞哥（codex版）", "prefix": "wbk_w381Wvo5" },
  "tokens":  { "used": 46295692 },
  "credits": { "used": 106.48 },
  "last_used_at": 1792459299 }
```

面板侧用到（全部只读）：

| 接口 | 用途 |
|---|---|
| `POST /api/login` | 只读账号换 `wb_session`（24h 有效，剩 1h 自动续） |
| `GET /api/keys` | 本 key 的已用积分 / tokens / 最后调用 |
| `GET /api/stats/by-key?days=1` | 本 key 今日消耗 |
| `GET /api/stats/summary` | 全站今日 / 本周 |
| `GET /api/accounts` | **全站积分余额**（各账号 `credits` 求和） |

> **不适配**：OneAPI / New API 那套 `/dashboard/billing/subscription` 的网关。想要的话可以按同样的方式加一个适配器（见 `lib/index.js` 里的 `collectFallback`）。

## 配置项

配置文件：`$DSH_HOME/.dshw-credits.json`（界面上「设置」改的就是它）

| 字段 | 说明 |
|---|---|
| `gatewayUrl` / `keyRef` | 网关地址与凭据名；**留空 = 自动识别** |
| `panelUrl` / `username` / `secret` | 面板地址与只读账号；不填就只有「本 key」数据 |
| `keyPrefix` | 锁定显示哪把 key；留空 = 按凭据前缀自动推断 |
| `thresholds` | `{ metric: used\|today\|pool, warn: 500, alert: 1000 }` |
| `icon` | 自定义图标（实际文件在 `$DSH_HOME/wb-credits/icon.*`） |
| `refreshMs` | 采集间隔，默认 5 分钟（最小 60 秒） |

## 隐私与安全

- 不联网上报、无遥测；所有数据只在你本机
- 面板密码：DPAPI（CurrentUser）加密；插件只读，不写面板任何数据
- 对外路由 `/dsh-wb-credits/*` 只接受**回环 Host 的同源请求**，跨站一律 403，返回值里没有任何密钥
- 图标上传按**文件头**判断真实类型（改扩展名无效），上限 2 MB

## 已知限制

- 面板只提供**按日**汇总，「今日」是面板口径
- 没有面板账号时，「今日」只能按「当天首个快照做差」估算，跨天会重置
- 面板会话 24h 过期，插件提前 1h 续期；密码改了要重新填
- 一个 profile 只装一份；换 key 会重新认前缀

## 开发

```bash
node tools/probe.mjs <面板账号> <密码> [keyPrefix]   # 不开 DSH，验证登录 + 取数
node tools/testbed.mjs 8731                        # 假页面里看胶囊效果（#wbcr-expand 直开面板）
node tools/auto-detect-test.mjs                    # 网关自动识别（可设 WB_TEST_KEY / WB_TEST_BASE 真连）
node tools/threshold-test.mjs                      # 阈值边界
python tools/make-icon.py                          # 重新生成 icon.png
powershell -File tools/deploy.ps1                  # 同步到本机 profile 的 node_modules
```

改完宿主代码要生效，需要让宿主重新 import 模块：把 `cordis.patch.yml` 里该条目的 `?v=` 变化一次（或重启 DSH）。

## 卸载

双击 `uninstall.cmd`，或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData   # 连配置/图标一起删
```

然后重启 DSH Desktop。

## English

A floating credit capsule for DSH Web that shows **your relay key's used credits**, **today's spend** and **the pool's credit balance** (for WorkBuddy / workbuddy2api style gateways).

- Zero-config: the plugin discovers your relay gateway from DSH's own model-provider settings.
- Optional read-only panel account unlocks the pool balance; the password is sealed with Windows DPAPI.
- Read-only by design: GET stats + one login call. No telemetry.

Install: `dsh plugin --profile web add github:zhanghongfeix/dsh-wb-credits`, or run `install.cmd` on Windows.

## License

MIT
