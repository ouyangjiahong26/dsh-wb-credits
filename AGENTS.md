# dsh-wb-credits

DSH Web 插件：右下角常驻一枚「中转站积分胶囊」，显示**本 key 已用积分**、**今日消耗**与**账号池积分余额**。

- 运行时：Node ≥ 20，**零第三方依赖**。宿主端 `lib/index.js`，前端 `assets/badge.js`（注入式挂件，不参与 React 渲染）。
- 数据源：workbuddy2api 风格网关的 `GET {baseURL}/usage`（无需登录）；可选填只读面板账号，额外解锁全站余额与按日统计。
- 网关**自动识别**：从 DSH 自己的模型 provider 配置里认出非官方 provider 与对应凭据名，所以装完通常不用配置。
- 安装：`dsh plugin --profile <profile> add github:zhanghongfeix/dsh-wb-credits`，或 Windows 下双击 `install.cmd`。

## 常用命令

```bash
node tools/probe.mjs <面板账号> <密码> [keyPrefix]   # 不开 DSH 验证登录 + 取数
node tools/testbed.mjs 8731                        # 假页面里看胶囊效果
node tools/auto-detect-test.mjs                    # 网关自动识别
node tools/threshold-test.mjs                      # 阈值边界
powershell -File tools/deploy.ps1                  # 同步到本机 profile
```

## Agent skills

本仓库的工程技能配置在 `docs/agents/`，**探索代码库前先读**：

| 文件 | 用途 |
| --- | --- |
| [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) | issue / PR 走哪个 tracker、用什么命令、标签怎么打 |
| [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md) | 五个分诊角色 → 本仓库标签字符串的映射 |
| [`docs/agents/domain.md`](docs/agents/domain.md) | 领域文档（`CONTEXT.md` / `docs/adr/`）怎么读、术语怎么用 |

- 领域文档布局：**单一上下文**（根目录 `CONTEXT.md` + `docs/adr/`），没有 `CONTEXT-MAP.md`。
- 领域文档尚不存在时，按 `docs/agents/domain.md` 的规则静默继续。
