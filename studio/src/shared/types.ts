/**
 * IPC 契约(v1)—— 主进程与渲染端的唯一通道。
 * 扩展:新增能力 = 新增类型 + ipc.ts 注册一个 handler + preload 暴露(泛型 invoke 无需改)。
 */
import type { AuditSource, WsBranchCheckpoint, WsBranchTaskView, WsInProgressView, WsOccupancyView, WsParallelView, WsPublishBranchView, WsTempItem, WsVersionView } from "versioncontrol-mcp/dist/workspace.js";
export type Theme =
  | "system"
  | "dark"
  | "dark-dimmed"
  | "dark-hc"
  | "light"
  | "light-hc"
  | "nord"
  | "dracula"
  | "one-dark"
  | "tokyo-night"
  | "solarized-dark"
  | "solarized-light";

/** 全局权限模式(未绑定路由的工具的兜底档);confirm 逐次审批从未实现,已移除 */
export type PermissionMode = "readonly" | "auto";

/** 工具接入路由:统一 MCP 接口上「指定某工具操作某项目」的绑定 */
export interface ClientRoute {
  /** 绑定默认项目(绝对路径):该工具不传 repoPath 时服务端自动路由到此 */
  repoPath?: string;
  /** 权限档:auto=可写(全留痕)/readonly=该工具的写工具全部被拦 */
  permission: "auto" | "readonly";
  /** 越界档:true=操作绑定项目之外直接拒绝;false=放行但警告并写审计(默认) */
  strict: boolean;
}

export interface StudioSettings {
  repoPath: string | null;
  recents: string[];
  mcpEnabled: boolean;
  mcpPort: number;
  permissionMode: PermissionMode;
  /** 我的项目首页布局 */
  viewStyle: "cards" | "list";
  /** 界面主题(GitHub 亮/暗) */
  theme: Theme;
  /** 用户自定义 AI 工具(与内置预设并列) */
  customClients?: CustomAiClient[];
  /** 工具接入路由表:key=接入名(HTTP 子路径 /mcp/<key> 或 stdio env PVC_CLIENT=<key>) */
  clientRoutes?: Record<string, ClientRoute>;
}

/** 自定义 AI 工具:match = 握手 clientInfo.name 的小写包含匹配关键词 */
export interface CustomAiClient {
  id: string;
  name: string;
  match: string;
  /** 可选:标准 mcpServers JSON 配置文件路径(支持一键写入) */
  configPath?: string;
}

export interface AiClientInfo {
  id: string;
  name: string;
  kind: "json-mcp" | "command" | "custom";
  configPath?: string;
  installed: boolean;
  docs: string;
}

export interface AiSnippet {
  text: string;
  configPath?: string;
}

export interface AiWriteResult {
  file: string;
  backup: string | null;
}

export interface HealthReport {
  ok: boolean;
  toolCount: number;
  error?: string;
  /** 路由/绑定漂移检测:指向不存在或非工作区路径的条目 */
  drift?: string[];
}

export interface ServiceStatus {
  running: boolean;
  port: number;
  url: string;
  mode: PermissionMode;
}

/** 应用内检查更新结果(开发态 supported=false;portable 产物自动更新不可用) */
export interface UpdateCheckResult {
  supported: boolean;
  current?: string;
  available?: boolean;
  version?: string | null;
  error?: string;
}

/** 一次 AI 工具握手(initialize)记录 */
export interface ConnectionEvent {
  time: string;
  transport: "http" | "stdio";
  client: string;
  version?: string;
}

/** 按客户端归并的连接信息 */
export interface ClientConnection {
  key: string;
  last: string;
  transport: string;
  rawName: string;
  count: number;
}

/** 设置页"AI 工具连接"模块的数据 */
export interface McpConnectionReport {
  service: ServiceStatus;
  /** 最近握手,最新在前(≤8 条) */
  events: ConnectionEvent[];
  /** key = 客户端 id(已知)或 "other:<名>" / "self" */
  connected: Record<string, ClientConnection>;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ProjectSummary {
  repoPath: string;
  isWorkspace: boolean;
  title: string;
  latest: string | null;
  versionCount: number;
  createdAt?: string;
  updatedAt?: string;
  /** 占用概况(isWorkspace 时提供):进行中版本归哪个工具、分支/temp 数、是否冲突中 */
  occupancy?: WsOccupancyView;
}

export type { WsVersionView, WsInProgressView, WsBranchTaskView, WsBranchCheckpoint, WsTempItem, WsParallelView, WsPublishBranchView, WsOccupancyView, AuditSource };

/** 文件级差异条目:A=新增 M=改动 D=删除 */
export interface DiffFileEntry {
  file: string;
  status: "A" | "M" | "D";
}

/** 通道名常量(主/渲染共用,防拼写漂移) */
export const CH = {
  settingsGet: "pvc:v1:settings:get",
  settingsSetRepo: "pvc:v1:settings:setRepo",
  settingsSetService: "pvc:v1:settings:setService",
  settingsSetViewStyle: "pvc:v1:settings:setViewStyle",
  settingsSetTheme: "pvc:v1:settings:setTheme",
  settingsRemoveRepo: "pvc:v1:settings:removeRepo",
  settingsCustomClients: "pvc:v1:settings:customClients",
  settingsSetRoutes: "pvc:v1:settings:setRoutes",
  projectsList: "pvc:v1:projects:list",
  pickRepo: "pvc:v1:dialog:pickRepo",
  wsStatus: "pvc:v1:ws:status",
  wsVersions: "pvc:v1:ws:versions",
  wsReadDoc: "pvc:v1:ws:readDoc",
  wsCreate: "pvc:v1:ws:create",
  pickParentDir: "pvc:v1:dialog:pickParentDir",
  wsInit: "pvc:v1:ws:init",
  wsRollback: "pvc:v1:ws:rollback",
  wsInProgress: "pvc:v1:ws:inprogress",
  wsTakeover: "pvc:v1:ws:takeover",
  wsDeleteCopy: "pvc:v1:ws:copyDelete",
  wsRestoreCopy: "pvc:v1:ws:copyRestore",
  wsParallel: "pvc:v1:ws:parallel",
  wsPublish: "pvc:v1:ws:publish",
  wsOffenders: "pvc:v1:ws:offenders",
  wsBranchBegin: "pvc:v1:ws:branchBegin",
  wsBranchAssign: "pvc:v1:ws:branchAssign",
  wsBranchAdopt: "pvc:v1:ws:branchAdopt",
  wsBranchRollback: "pvc:v1:ws:branchRollback",
  wsBranchUpdate: "pvc:v1:ws:branchUpdate",
  wsBranchMerge: "pvc:v1:ws:branchMerge",
  wsBranchDiscard: "pvc:v1:ws:branchDiscard",
  wsTempApply: "pvc:v1:ws:tempApply",
  wsTempDiscard: "pvc:v1:ws:tempDiscard",
  wsMigrate: "pvc:v1:ws:migrate",
  fileAt: "pvc:v1:file:at",
  versionFiles: "pvc:v1:version:files",
  diffFiles: "pvc:v1:diff:files",
  aiClients: "pvc:v1:ai:clients",
  aiSnippet: "pvc:v1:ai:snippet",
  aiWrite: "pvc:v1:ai:write",
  aiHealth: "pvc:v1:ai:health",
  mcpConnections: "pvc:v1:mcp:connections",
  serviceStatus: "pvc:v1:service:status",
  openItem: "pvc:v1:open:showItem",
  appUpdateCheck: "pvc:v1:app:updateCheck",
  appUpdateInstall: "pvc:v1:app:updateInstall",
  changed: "pvc:v1:changed",
} as const;
