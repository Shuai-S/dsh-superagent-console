/** Setup-card dictionaries for the gated console (separate namespace from the official panel). */

export type SetupKey =  | 'panel'
  | 'loading'
  | 'loadFailed'
  | 'retry'
  | 'titleStopped'
  | 'titleUnhealthy'
  | 'titleNotInstalled'
  | 'titlePrereq'
  | 'descStopped'
  | 'descUnhealthy'
  | 'descNotInstalled'
  | 'descPrereq'
  | 'install'
  | 'installResume'
  | 'installing'
  | 'installDone'
  | 'start'
  | 'restart'
  | 'starting'
  | 'restarting'
  | 'prereqsTitle'
  | 'stageTitle'
  | 'setupWait'
  | 'manuallyStopped'
  | 'target'
  | 'actionFailed'
  | 'engineError'
  | 'installFailed'
  | 'syncTitle'
  | 'syncDiff'
  | 'syncNoDiff'
  | 'syncSource'
  | 'syncEngine'
  | 'syncSourceMissing'
  | 'syncEngineMissing'
  | 'syncAdded'
  | 'syncChanged'
  | 'syncRemoved'
  | 'syncModeLabel'
  | 'syncModeMerge'
  | 'syncModeMirror'
  | 'syncDo'
  | 'syncDoing'
  | 'syncDone'
  | 'syncBackup'
  | 'syncSkipped'
  | 'syncRestartHint'
  | 'syncRestartPending'
  | 'syncAutoOn'
  | 'syncFailed'
  | 'syncUnavailable'

export type SetupT = (key: SetupKey) => string

export const setupZh: Record<SetupKey, string> = {
  panel: 'Superagent 控制台',
  loading: '正在检测引擎状态…',
  loadFailed: '状态检测失败',
  retry: '重试',
  titleStopped: '引擎已安装，但未启动',
  titleUnhealthy: '引擎已启动，但状态异常',
  titleNotInstalled: '未检测到 Superagent 引擎',
  titlePrereq: '缺少前置依赖，暂无法安装',
  descStopped: '引擎服务处于停止状态，可以一键拉起（tmux 会话由生命周期脚本托管）。',
  descUnhealthy: '引擎进程存在但管理 API 不可达或组件报错，可尝试重启。',
  descNotInstalled: '引擎运行在独立的 DSH profile 中。点击安装后，控制台会在线拉取官方源码、自动构建并部署到独立 profile（npm 上无此包，源码构建是官方唯一安装路径）。',
  descPrereq: '在线安装需要以下工具，请先补齐后再安装（凭据类操作仍需本人完成）。',
  install: '在线安装引擎',
  installResume: '继续安装',
  installing: '正在安装…',
  installDone: '安装完成',
  start: '启动引擎',
  restart: '重启引擎',
  starting: '正在启动…',
  restarting: '正在重启…',
  prereqsTitle: '前置依赖',
  stageTitle: '安装进度',
  setupWait: '引擎已启动，正在等待首次配置（Source 设置需在引擎面板完成）。',
  manuallyStopped: '引擎带有手动停止标记，已按需忽略。',
  target: '引擎地址',
  actionFailed: '操作失败',
  engineError: '引擎组件错误',
  installFailed: '安装失败',
  syncTitle: '模型供应商同步',
  syncDiff: '与引擎 profile 的差异',
  syncNoDiff: '引擎 profile 与本端供应商一致，无需同步。',
  syncSource: '本端（settings 生效值）',
  syncEngine: '引擎 profile',
  syncSourceMissing: '本端供应商不可读：settings 服务未注入或无 llm-pi-ai 条目。',
  syncEngineMissing: '引擎 profile 不可读：',
  syncAdded: '引擎缺少（将补齐）',
  syncChanged: '两侧都有但配置不同',
  syncRemoved: '仅引擎有',
  syncModeLabel: '同步模式',
  syncModeMerge: '增补（只加缺的，已有不动）',
  syncModeMirror: '镜像（引擎供应商全量替换为本端）',
  syncDo: '同步到引擎 profile',
  syncDoing: '同步中…',
  syncDone: '已写入引擎 profile',
  syncBackup: '备份',
  syncSkipped: '已跳过',
  syncRestartHint: '需要重启引擎生效。',
  syncRestartPending: '重启引擎以加载新供应商',
  syncAutoOn: '自动同步已开启',
  syncFailed: '同步失败',
  syncUnavailable: '（不可用）',
}

export const setupEn: Record<SetupKey, string> = {
  panel: 'Superagent Console',
  loading: 'Detecting engine state…',
  loadFailed: 'Detection failed',
  retry: 'Retry',
  titleStopped: 'Engine installed but not running',
  titleUnhealthy: 'Engine running but unhealthy',
  titleNotInstalled: 'Superagent engine not found',
  titlePrereq: 'Prerequisites missing — install blocked',
  descStopped: 'The engine service is stopped. Start it with one click (the tmux session is managed by the lifecycle script).',
  descUnhealthy: 'The engine process exists but the management API is unreachable or a component reports an error. Try a restart.',
  descNotInstalled: 'The engine runs in its own dedicated DSH profile. Installing fetches the official source online, builds it, and deploys it into that profile (the package is not published to npm; source build + link is the only official path).',
  descPrereq: 'The online installer needs the tools below. Install them first (credential steps stay yours).',
  install: 'Install engine online',
  installResume: 'Resume install',
  installing: 'Installing…',
  installDone: 'Install complete',
  start: 'Start engine',
  restart: 'Restart engine',
  starting: 'Starting…',
  restarting: 'Restarting…',
  prereqsTitle: 'Prerequisites',
  stageTitle: 'Install progress',
  setupWait: 'Engine is up and waiting for first-time setup (Source configuration happens in the engine panel).',
  manuallyStopped: 'The engine carries a manual-stop marker; honored on demand.',
  target: 'Engine target',
  actionFailed: 'Action failed',
  engineError: 'Engine component errors',
  installFailed: 'Install failed',
  syncTitle: 'Model provider sync',
  syncDiff: 'Differences against the engine profile',
  syncNoDiff: 'The engine profile matches this host\'s providers — nothing to sync.',
  syncSource: 'This host (live settings)',
  syncEngine: 'Engine profile',
  syncSourceMissing: 'Host providers unreadable: settings service not injected or no llm-pi-ai entry.',
  syncEngineMissing: 'Engine profile unreadable: ',
  syncAdded: 'Missing on engine (will append)',
  syncChanged: 'Present on both, configured differently',
  syncRemoved: 'Engine only',
  syncModeLabel: 'Sync mode',
  syncModeMerge: 'Merge (append missing only, keep the rest)',
  syncModeMirror: 'Mirror (replace engine providers with this host\'s)',
  syncDo: 'Sync into engine profile',
  syncDoing: 'Syncing…',
  syncDone: 'Written into the engine profile',
  syncBackup: 'Backup',
  syncSkipped: 'Skipped',
  syncRestartHint: 'Restart the engine for the change to take effect.',
  syncRestartPending: 'Restart engine to load the new providers',
  syncAutoOn: 'Auto sync enabled',
  syncFailed: 'Sync failed',
  syncUnavailable: ' (unavailable)',
}

// Register the setup namespace in the typed locale registry, the same way the
// official panel declares `dshSuperagent` (see vendored client/locales.ts).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshSuperagentConsole: SetupKey }
}
