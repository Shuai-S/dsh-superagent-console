# dsh-superagent-console

桌面端 Superagent 控制台插件：侧边栏面板 + 同源代理，**引擎仍运行在独立的 superagent profile**（tmux，127.0.0.1:3082），本插件不承载任何引擎状态。

## 架构

```
桌面 App（desktop profile）
└─ dsh-superagent-console
   ├─ 宿主：/orchestrator/api 前缀路由 → 代理转发 127.0.0.1:3082（补 x-orchestrator-request 头）
   └─ 客户端：vendor 的官方 dsh-superagent 面板（ModuleLoader id 重写为本插件名）
```

## 构建

```sh
pnpm install
pnpm build     # 先 sync-client（从 ../dsh-superagent-prototype/lib/client.js vendor 并改写 id），再 tsdown
pnpm check     # typecheck + build
```

## 代理独立验证（不碰桌面进程）

```sh
pnpm test:proxy   # 需要引擎已启动；在 3088 起临时服务器实测转发
```

## 安装到桌面端

```sh
dsh plugin --profile desktop add "link:$PWD"
```

安装后桌面 App 需重载 profile 才会加载插件与客户端（具体时机见会话记录）。

## 升级引擎后同步客户端

```sh
cd ../dsh-superagent-prototype && pnpm build && cd ../dsh-superagent-console && pnpm sync-client
```
