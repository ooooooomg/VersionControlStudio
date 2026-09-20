/** 渲染端类型化 API 封装:全部经 preload 暴露的 window.pvc 通道 */
import { CH, type AiClientInfo, type ClientRoute, type CustomAiClient, type McpConnectionReport, type Theme, type AiSnippet, type AiWriteResult, type DiffFileEntry, type Envelope, type HealthReport, type ProjectSummary, type ServiceStatus, type StudioSettings, type UpdateCheckResult, type WsBranchCheckpoint, type WsBranchTaskView, type WsInProgressView, type WsOccupancyView, type WsParallelView, type WsPublishBranchView, type WsTempItem, type WsVersionView } from "../shared/types.js";

declare global {
  interface Window {
    pvc: {
      invoke: (channel: string, payload?: unknown) => Promise<Envelope<never>>;
      onChanged: (cb: () => void) => () => void;
    };
  }
}

async function inv<T>(channel: string, payload?: unknown): Promise<T> {
  const env = (await window.pvc.invoke(channel, payload)) as Envelope<T>;
  if (!env.ok) throw new Error(env.error);
  return env.data;
}

export const pvc = {
  settingsGet: () => inv<StudioSettings>(CH.settingsGet),
  pickRepo: () => inv<StudioSettings | null>(CH.pickRepo),
  setRepo: (repoPath: string) => inv<StudioSettings>(CH.settingsSetRepo, { repoPath }),
  setService: (patch: { mcpEnabled?: boolean; mcpPort?: number; permissionMode?: string }) =>
    inv<StudioSettings>(CH.settingsSetService, patch),
  setViewStyle: (viewStyle: "cards" | "list") =>
    inv<StudioSettings>(CH.settingsSetViewStyle, { viewStyle }),
  setTheme: (theme: Theme) => inv<StudioSettings>(CH.settingsSetTheme, { theme }),
  projectsList: () => inv<ProjectSummary[]>(CH.projectsList),
  removeProject: (repoPath: string) => inv<StudioSettings>(CH.settingsRemoveRepo, { repoPath }),
  setCustomClients: (list: CustomAiClient[]) => inv<StudioSettings>(CH.settingsCustomClients, { list }),
  setRoutes: (key: string, route: ClientRoute | null) => inv<StudioSettings>(CH.settingsSetRoutes, { key, route }),
  wsCreate: (p: { parentDir: string; title: string }) => inv<string>(CH.wsCreate, p),
  pickParentDir: () => inv<string | null>(CH.pickParentDir),
  wsStatus: (repoPath?: string) => inv<string>(CH.wsStatus, { repoPath }),
  wsVersions: (repoPath?: string) => inv<WsVersionView[]>(CH.wsVersions, { repoPath }),
  wsReadDoc: (p: { code?: string; which: "purpose" | "changes" | "workspaceLog" }) =>
    inv<string>(CH.wsReadDoc, p),
  wsInit: (p: { dir: string; title: string }) => inv<string>(CH.wsInit, p),
  wsRollback: (p: {
    code: string;
    reason?: string;
    discardDirty?: boolean;
    resolveInProgress?: "stash";
  }) => inv<string>(CH.wsRollback, p),
  wsInProgress: () => inv<WsInProgressView | null>(CH.wsInProgress),
  wsTakeover: (p: { mode: "continue" | "fresh"; requirement?: string }) =>
    inv<string>(CH.wsTakeover, p),
  wsDeleteCopy: (code: string) => inv<string>(CH.wsDeleteCopy, { code }),
  wsRestoreCopy: (code: string) => inv<string>(CH.wsRestoreCopy, { code }),
  wsParallel: () => inv<WsParallelView>(CH.wsParallel),
  wsOffenders: (repoPath?: string) => inv<string[]>(CH.wsOffenders, { repoPath }),
  wsPublishBranches: () => inv<WsPublishBranchView[]>(CH.wsPublish),
  wsBranchBegin: (p: { requirement: string; name?: string; assignee?: string; base?: string }) =>
    inv<{ message: string; token: string; branch: string; worktree: string }>(CH.wsBranchBegin, p),
  wsBranchAssign: (p: { name: string; assignee?: string }) => inv<string>(CH.wsBranchAssign, p),
  wsBranchAdopt: (p: { name: string; requirement: string; assignee?: string }) =>
    inv<string>(CH.wsBranchAdopt, p),
  wsBranchRollback: (p: { name: string; to?: string; force?: boolean }) =>
    inv<string>(CH.wsBranchRollback, p),
  wsBranchUpdate: (name: string) => inv<string>(CH.wsBranchUpdate, { name }),
  wsBranchMerge: (p: { name: string; summary?: string; abort?: boolean }) =>
    inv<string>(CH.wsBranchMerge, p),
  wsBranchDiscard: (name: string, force?: boolean) =>
    inv<string>(CH.wsBranchDiscard, { name, force }),
  wsTempApply: (name: string) => inv<string>(CH.wsTempApply, { name }),
  wsTempDiscard: (name: string) => inv<string>(CH.wsTempDiscard, { name }),
  wsMigrate: (p: { newDir: string; oldRepo: string; title: string }) =>
    inv<string>(CH.wsMigrate, p),
  fileAt: (p: { ref: string; file: string }) => inv<string>(CH.fileAt, p),
  versionFiles: (ref: string) => inv<string[]>(CH.versionFiles, { ref }),
  diffFiles: (from: string, to: string) => inv<DiffFileEntry[]>(CH.diffFiles, { from, to }),
  aiClients: () => inv<AiClientInfo[]>(CH.aiClients),
  aiSnippet: (id: string, client?: string) => inv<AiSnippet>(CH.aiSnippet, { id, client }),
  aiWrite: (id: string, client?: string) => inv<AiWriteResult>(CH.aiWrite, { id, client }),
  aiHealth: () => inv<HealthReport>(CH.aiHealth),
  mcpConnections: () => inv<McpConnectionReport>(CH.mcpConnections),
  serviceStatus: () => inv<ServiceStatus>(CH.serviceStatus),
  openItem: (path: string) => inv<void>(CH.openItem, { path }),
  appUpdateCheck: () => inv<UpdateCheckResult>(CH.appUpdateCheck),
  appUpdateInstall: () => inv<{ started: boolean }>(CH.appUpdateInstall),
  onChanged: (cb: () => void) => window.pvc.onChanged(cb),
};

export type {
  AiClientInfo,
  AiSnippet,
  AiWriteResult,
  ClientRoute,
  CustomAiClient,
  DiffFileEntry,
  HealthReport,
  McpConnectionReport,
  ProjectSummary,
  ServiceStatus,
  StudioSettings,
  UpdateCheckResult,
  WsInProgressView,
  WsBranchTaskView,
  WsBranchCheckpoint,
  WsOccupancyView,
  WsParallelView,
  WsPublishBranchView,
  WsTempItem,
  WsVersionView,
};
