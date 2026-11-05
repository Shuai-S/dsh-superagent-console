# dsh-superagent-console

dsh-superagent 引擎的桌面控制台插件：同源代理 + 引擎状态检测 + 引导式在线安装 + 插件管理 + 模型供应商同步。引擎运行于独立的 superagent profile（默认 `127.0.0.1:3082`），本插件不承载任何引擎状态。

## 功能

- **同源代理**：宿主 `/orchestrator/api` 转发至引擎（补 `x-orchestrator-request` 头），控制台自有 API 位于 `/superagent-console/api`
- **引擎检测**：L0–L3 分层探针，状态与动作一一映射
- **引导式在线安装**：八段流水线（`prereqs → checkout → build → profile → plugin → patch → start → verify`），每段幂等、支持断点续跑
- **插件管理**：面板内直接安装/移除/启停引擎 profile 的插件
- **模型供应商同步**：把宿主生效的 `llm-pi-ai.providers` 同步到引擎 profile

## 架构

```
桌面 App（desktop profile）
└─ dsh-superagent-console
   ├─ 宿主 /orchestrator/api        → 同源代理转发引擎（补 x-orchestrator-request 头）
   ├─ 宿主 /superagent-console/api  → 控制台自有 API（检测 / 安装 / 启动 / 重启 / 插件管理 / 供应商同步）
   └─ 客户端                        → 门控面板：引擎在线时挂官方面板（含「插件」管理 Tab），
                                       否则渲染安装引导状态卡
```

## 引擎检测（L0–L3 分层探针）

| 层 | 探测 | 判定 |
|---|---|---|
| L0 | 服务端 fetch `{target}/orchestrator/api/state`（带 `x-orchestrator-request: 1`） | 引擎可达 |
| L1 | 引擎 profile 的 package.json 依赖含 `dsh-superagent` 且 checkout 存在 `lib/` 产物 | 服务已部署 |
| L2 | 引擎生命周期脚本 `scripts/dsh-superagent status`（exit 0 健康 / 1 停止 / 2 组件错误 / 3 等待 setup） | 健康细分 |
| L3 | dsh ≥0.2.1、node ^22.19\|\|≥24、pnpm、git、tmux、python3（缺项附补齐提示命令） | 前置依赖 |

状态 → 动作映射：`running` → 官方面板；`installed-stopped` → 启动按钮；`installed-unhealthy` → 重启按钮；`not-installed` → 在线安装；`prereq-missing` → 列出缺项与补齐命令（不提供安装按钮）。

探测 PATH 由 `spawnPath` 组装：运行中 node 的 bin 目录 + 配置的 `extraPath` + **桌面 App 自带的 dsh CLI 目录**（从运行中二进制相对推导 `<App>.app/Contents/Resources/runtime/cli/bin`，存在才追加）。因此桌面用户无需自行安装 dsh；`extraPath` 中显式安装的用户版本优先于内置 CLI。

## 在线安装流水线

`prereqs → checkout → build → profile → plugin → patch → start → verify`

- **来源**：`git clone` 官方仓库（`dsh-superagent` 在 npm 上不存在且 `private: true`，GitHub 无 release；源码构建 + link 是官方唯一路径）。
- **自管目录**：默认 `~/.dsh/state/superagent-console/engine`（clone 与构建位置），随附 `setup.json`（断点续跑状态）与 `audit.jsonl`（审计日志）。
- **守卫**：
  - `dsh <profile> --from-default-profile web` 是覆盖式命令（源码确认：replace a fresh copy），profile 目录存在即拒绝执行；
  - profile 的 `cordis.patch.yml` 已存在则不覆盖（其中含操作者手工维护的 Source 配置）；
  - clone 目标目录非空且非 git 仓库即拒绝；
  - 单实例锁（进程内互斥 + pid 锁文件，跨桌面重启可检测陈锁）；
  - 全部命令走 `execFile` argv 数组（不经过 shell 拼接），超时必杀，审计脱敏 `user:pass@`。
- **每段幂等**：已完成段自动跳过，失败段重按「继续安装」即从断点续跑。
- 首次启动 exit 3（等待 Source setup）属预期，verify 段放行。

启动/重启复用引擎自带生命周期脚本 `scripts/dsh-superagent start|restart`（无头托管、拒绝重复启动、URL 冲突检测），`--profile/--url` 由插件配置注入。

## 插件管理 Tab

官方面板内新增「插件」Tab，管理 superagent 引擎 profile 的插件依赖：

- **列表**：profile package.json 依赖清单 + 已安装版本/描述 + 是否声明 `dsh.bundle` + 是否在 `dsh.profile.bundles` 挂载集内；引擎核心 `dsh-superagent` 标记保护（不可移除/停用）。
- **安装 / 移除**：走官方 CLI 路径 `dsh plugin --profile superagent add|remove <spec>`（单飞互斥、输出脱敏、审计日志），复用安装器的 bundle reconcile 语义；改动在**重启引擎后生效**，页面提供重启按钮。
- **启停（挂载集编辑）**：原子改写 profile package.json 的 `dsh.profile.bundles`（保留 0600 权限；无变更不写盘）；与安装/移除共用同一互斥。

## 模型供应商同步

引擎的模型目录来自其所在 profile 的 `llm-pi-ai` 配置，且引擎管理 API 对供应商只读，因此引擎侧唯一写入面是 profile `cordis.patch.yml` 的 `llm-pi-ai` 条目。本插件把安装宿主当前生效的 `llm-pi-ai.providers`（settings 服务 `describe()` 读取）同步过去：

- **merge（默认）**：只把引擎缺少的 provider 追加进 `providers:`，已有条目一律不动（尊重手工维护）；
- **mirror**：引擎 providers 全量替换为本端（减去排除清单），引擎侧多出的删除；
- **排除清单** `syncExclude`：其中的 provider id 既不复制也不删除；
- **凭据守卫**：provider 配置携带明文 `apiKey`/`apiToken` 字段时跳过并告警——只同步引用型凭据（`apiKeyEnv` 环境变量名），秘密值永不复制；
- **文件手术**：只改 `llm-pi-ai` 这一个条目，其余条目与全部注释逐字节保留；写前时间戳备份（保留最近 5 份）、临时文件原子写、写后 YAML 重解析验证（`llm-pi-ai` 条目不完整即拒绝落盘）；
- **幂等**：输入不变时第二跑零写入；
- **生效**：写盘后需重启引擎（卡片提示一键重启）；`autoSync` 开启时监听宿主 settings 变化（30s 轮询 diff），`autoRestart` 开启且引擎在运行时同步后自动重启。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `target` | `http://127.0.0.1:3082` | 引擎地址 |
| `repoUrl` | `git@github.com:deepseek-ai/dsh-superagent-prototype.git` | 安装来源仓库 |
| `engineDir` | `~/.dsh/state/superagent-console/engine` | 安装器自管目录 |
| `profileName` | `superagent` | 引擎独立 profile 名（永不指向 desktop） |
| `extraPath` | `~/.local/bin:/usr/local/bin:/opt/homebrew/bin` | 桌面进程 PATH 偏窄时为子进程补充的工具目录 |
| `syncMode` | `merge` | 供应商同步模式：`merge` 只补缺，`mirror` 全量镜像 |
| `syncExclude` | `[]` | 同步不碰的 provider id（既不复制也不删除） |
| `autoSync` | `false` | 宿主 settings 变化时自动同步引擎 profile（30s 轮询 diff） |
| `autoRestart` | `false` | 自动同步后且引擎在运行时自动重启引擎 |

## 安装

```sh
# 从 npm 安装
dsh plugin --profile desktop add dsh-superagent-console

# 或从本地源码安装（开发场景）
dsh plugin --profile desktop add "link:$PWD"
```

安装后桌面 App 需重载 profile 才会加载插件与客户端。

## License

MIT
