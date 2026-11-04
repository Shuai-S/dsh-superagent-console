# dsh-superagent-console

桌面端 Superagent 控制台插件：侧边栏面板 + 同源代理 + **引擎检测与在线安装** + **模型供应商同步**。引擎仍运行在独立的 superagent profile（tmux，默认 127.0.0.1:3082），本插件不承载任何引擎状态。

## 架构

```
桌面 App（desktop profile）
└─ dsh-superagent-console
   ├─ 宿主 /orchestrator/api        → 同源代理转发 127.0.0.1:3082（补 x-orchestrator-request 头）
   ├─ 宿主 /superagent-console/api  → 控制台自有 API（检测 / 安装 / 启动 / 重启 / 插件管理 / 供应商同步）
   └─ 客户端                        → 门控面板：引擎在线时挂官方面板（含「插件」管理 Tab），
                                       否则渲染安装引导卡（状态卡）

## 插件管理 Tab（2026-11-04）

官方面板内新增「插件」Tab（位于「设置」之后），管理 superagent 引擎 profile 的插件依赖：

- **列表**：profile package.json 的依赖清单 + 已安装版本/描述 + 是否声明 `dsh.bundle` + 是否在 `dsh.profile.bundles` 挂载集内；引擎核心 `dsh-superagent` 标记保护（不可移除/停用）。
- **安装 / 移除**：走官方 CLI 路径 `dsh plugin --profile superagent add|remove <spec>`（execFile argv 数组、单飞互斥、输出脱敏、audit.jsonl 审计），复用安装器的 bundle reconcile 语义；改动在**重启引擎后生效**，页面提供重启按钮。
- **启停（挂载集编辑）**：直接原子改写 profile package.json 的 `dsh.profile.bundles`（保留 0600 权限；无变更不写盘）；与安装/移除共用同一互斥。
- API：`GET/POST /superagent-console/api/plugins[/install|/remove|/enable|/operation]`，实现见 `src/plugins.ts`（运行时验证：假 profile 16 项断言 + 真实 profile 只读 list）。

vendor 补丁（seams）：`sync-client.mjs` 在每次 vendor 复制后，对 `client/route.ts`（TABS/Route/parseRoute）、`client/app.tsx`（路由分支 + import）、`client/locales.ts`（`tab.plugins` + `plugins.*` 双语词典）施加**精确锚点补丁**；上游锚点漂移会让 sync 显式失败，不会打出半接线的 Tab。页面本体在 `src/client/plugins-page.tsx`（自有文件，不受 vendor 覆盖）。
```

客户端构建：`sync-client.mjs` 从原型 checkout **递归 vendor 客户端源码图**到 `src/vendor/`（104 个文件，树形镜像，相对引用原样保留），随后施加「插件 Tab」seam 补丁（见下节），再由 tsdown 打成带 `window.__ModuleLoader__` banner 的自建 bundle（id `dsh-superagent-console`）。运行时外部依赖只有 react 系，与官方编译产物一致（零 node:*、零 zod 内联）。

## 引擎检测（L0-L3 分层探针）

| 层 | 探测 | 判定 |
|---|---|---|
| L0 | 服务端 fetch `{target}/orchestrator/api/state`（带 `x-orchestrator-request: 1`） | 引擎可达 |
| L1 | `~/.dsh/profiles/<profile>/package.json` 依赖含 `dsh-superagent` + checkout 有 `lib/` 产物 | 服务已部署 |
| L2 | `scripts/dsh-superagent status`（exit 0 健康 / 1 停止 / 2 组件错误 / 3 等待 setup） | 健康细分 |
| L3 | dsh ≥0.2.1、node ^22.19\|\|≥24、pnpm、git、tmux、python3（缺项附补齐提示命令） | 前置依赖 |

状态 → 动作一一映射：`running` → 官方面板；`installed-stopped` → 启动按钮；`installed-unhealthy` → 重启按钮；`not-installed` → 在线安装；`prereq-missing` → 列出缺项与补齐命令（不提供安装按钮）。

探测 PATH 由 `spawnPath` 组装：运行中 node 的 bin 目录 + 配置的 `extraPath` + **桌面 App 自带的 dsh CLI 目录**（从运行中二进制相对推导 `<App>.app/Contents/Resources/runtime/cli/bin`，存在才追加）。因此桌面用户无需自行安装 dsh；`extraPath` 中显式安装的用户版本优先于内置 CLI。

## 在线安装流水线（8 段）

`prereqs → checkout → build → profile → plugin → patch → start → verify`

- **来源**：`git clone` 官方仓库（npm 上无此包——`dsh-superagent` 404 且 `private: true`，GitHub 无 release；源码构建 + link 是官方唯一路径）。
- **自管目录**：默认 `~/.dsh/state/superagent-console/engine`（clone 与构建位置），随附 `setup.json`（断点续跑状态）与 `audit.jsonl`（审计日志）。
- **守卫**：
  - `dsh <profile> --from-default-profile web` 是**覆盖式**命令（源码确认：replace a fresh copy），profile 目录存在即拒绝执行；
  - profile 的 `cordis.patch.yml` 已存在则不覆盖（内有操作者手工维护的 Source 配置）；
  - clone 目标目录非空且非 git 仓库即拒绝；
  - 单实例锁（进程内互斥 + pid 锁文件，跨桌面重启可检测陈锁）；
  - 全部命令走 `execFile` argv 数组（永不 shell 拼接），超时必杀，审计脱敏 `user:pass@`。
- **每段幂等**：已完成段自动跳过，失败段重按"继续安装"即从断点续跑。
- 首次启动 exit 3（等待 Source setup）属预期，verify 段放行。

## 启动 / 重启引擎

复用引擎自带生命周期脚本 `scripts/dsh-superagent start|restart`（tmux 无头托管、拒绝重复启动、尊重 URL 冲突检测），`--profile/--url` 由插件配置注入。

## 模型供应商同步

引擎的模型目录来自其所在 profile 的 `llm-pi-ai` 配置，且引擎管理 API 对供应商**只读**（settings 块仅 policy/eval/executor/pause/source），因此引擎侧唯一写入面是 `~/.dsh/profiles/<profileName>/cordis.patch.yml` 的 `llm-pi-ai` 条目。本插件把安装宿主（desktop/web profile）当前生效的 `llm-pi-ai.providers`（settings 服务 `describe()` 读取，含 dsh-sub2api-sync 写入的路由）同步过去：

- **merge（默认）**：只把引擎缺少的 provider 追加进 `providers:`，已有条目一律不动（尊重手工维护）；
- **mirror**：引擎 providers 全量替换为本端（减去排除清单），引擎侧多出的删除；
- **排除清单** `syncExclude`：其中的 provider id 既不复制也不删除；
- **凭据守卫**：provider 配置携带明文 `apiKey`/`apiToken` 字段时跳过并告警——只同步引用型凭据（`apiKeyEnv` 环境变量名），秘密值永不复制；
- **文件手术**：只改 `llm-pi-ai` 这一个条目，其余条目（Source 配置、`agent-default-model` 等）与全部注释逐字节保留；写前时间戳备份（保留最近 5 份）、临时文件原子写、写后 YAML 重解析验证（`llm-pi-ai` 条目不完整即拒绝落盘）；
- **幂等**：输入不变时第二跑零写入；
- **生效**：写盘后需重启引擎（卡片提示一键重启）；`autoSync` 开启时监听宿主 settings 变化（30s 轮询 diff），`autoRestart` 开启且引擎在运行时同步后自动重启。

API：`GET /superagent-console/api/providers`（两侧摘要 + diff + 同步状态）、`POST /superagent-console/api/providers/sync`（body `{ mode? }`，409 单飞冲突）。settings 服务经 `ctx.inject(['settings'], …)` 可选注入：宿主没有该服务时同步功能不激活，插件其余功能不受影响。

## 配置项（默认值均为通用约定，不绑定具体机器）

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

## 构建

```sh
pnpm install
pnpm build     # 先 sync-client（vendor 源码图），再 tsdown（node ESM + browser CJS 双产物）
pnpm check     # typecheck + build
```

升级引擎面板：原型 checkout 更新后 `pnpm build && cd ../dsh-superagent-console && pnpm build`（vendor 重新拉取源码图）。若在 worktree 内构建，sync 脚本会经 `git rev-parse --git-common-dir` 定位主 checkout 的兄弟目录。

## 代理独立验证（不碰桌面进程）

```sh
pnpm test:proxy   # 需要引擎已启动；在 3088 起临时服务器实测转发
```

## 安装隔离演练（不碰现有 superagent profile）

```sh
pnpm test:install -- --status-only   # 仅跑检测探针
pnpm test:install                    # 全流程：superagent-test profile + /tmp checkout + 3099 端口
```

演练产物清理（验完执行，注意这些路径仅属于演练）：

```sh
python3 /tmp/sa-console-rehearsal/engine/scripts/dsh-superagent stop --profile superagent-test --url http://127.0.0.1:3099
rm -rf /tmp/sa-console-rehearsal ~/.dsh/profiles/superagent-test ~/.dsh/state/superagent-test
```

## 安装到桌面端

```sh
dsh plugin --profile desktop add "link:$PWD"
```

安装后桌面 App 需重载 profile 才会加载插件与客户端。重建后重新激活即生效，勿重装。
