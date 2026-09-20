export declare const WS_MAIN_DIR = "main";
/** 微调级 bump(工作区版本号 Z 段);里程碑 major 由 v3 各调用点单独联合 */
export type Bump = "content" | "polish";
/** 工作区路径解析:显式参数 > 环境变量 PAPER_VERSION_REPO > 当前目录 */
export declare function resolveRepo(explicit?: string): string;
export type AuditSource = "gui" | "mcp-http" | "mcp-stdio" | "cli" | "api";
/** 调用方标识:source=传输通道,client=具体 AI 工具(统一 MCP 接口按工具归因,本地通道无 client) */
export interface AuditTag {
    source: AuditSource;
    /** 工具标识(HTTP 子路径 /mcp/<client> 或 stdio env PVC_CLIENT;GUI/CLI 等本地通道为空) */
    client?: string;
}
/** 兼容旧签名:纯字符串(仅传输通道)或完整标识对象 */
export type SourceLike = AuditSource | AuditTag;
export declare function normTag(tag?: SourceLike): AuditTag;
/** 审计/锁/展示用的来源标注:传输通道[:工具],如 mcp-http:claude */
export declare function tagLabel(tag: SourceLike): string;
export declare const WS_MAIN = "main";
export declare const WS_LOG = "\u5DE5\u4F5C\u533A\u65E5\u5FD7.md";
export declare const WS_DIR = ".vcs";
export declare const WS_REGISTRY = ".vcs/registry.json";
export declare const WS_AUDIT = ".vcs/audit.log";
/** 并行分支工作树根(git worktree,共享对象库不复制历史) */
export declare const WS_BRANCH_DIR = ".vcs/branch";
/** temp 补救区:无法提交时保全 main/ 变化 */
export declare const WS_TEMP_DIR = "temp";
export interface WsVersion {
    code: string;
    /** 用户更新目的(需求) */
    purpose: string;
    /** 相对上一版的改动摘要 */
    changes: string;
    date: string;
    source: AuditSource;
    /** 收尾方工具标识(统一接口归因;旧版本无此字段) */
    client?: string;
    /** 回滚时物化的项目副本位于本版本文件夹 */
    materialized?: boolean;
    /** 迁移来源标注(原编号等) */
    origin?: string;
    /** 迁移来源库(回滚时从该库 tag 取内容) */
    originRepo?: string;
    /** 迁移来源库的管理路径(取内容范围) */
    originIncludes?: string[];
    /** 由哪个并行分支合并而来(vcs_branch_merge 定版时记录) */
    mergedFrom?: string;
}
export interface WsInProgress {
    code: string;
    /** 展示用备注(= requirement,GUI 读取) */
    note?: string;
    requirement: string;
    baseline: string;
    startedAt: string;
    /** 目标阶段(V 工作区模型恒为 "V") */
    stage?: string;
    /** 会话所有权令牌(vcs_begin 签发;旧版登记的进行中版本无此字段,收尾须先接管) */
    owner?: string;
    /** 签发来源(审计/展示用) */
    ownerSource?: AuditSource;
    /** 签发方工具标识(HTTP 子路径 / stdio env 归因;旧版登记无此字段) */
    ownerClient?: string;
    /** 最近活跃时间(持有者携带令牌的工具调用刷新;超 30 分钟视为疑似停滞) */
    lastActiveAt?: string;
}
/** 并行分支任务(主工作区被占时,其他需求在独立 worktree 上开发) */
export interface WsBranchTask {
    /** 短名(唯一,worktree 目录名) */
    name: string;
    /** git 分支名 vcs/task/<name> */
    branch: string;
    /** 工作树相对工作区根的路径(.vcs/branch/<name>) */
    worktree: string;
    requirement: string;
    token: string;
    ownerSource: AuditSource;
    /** 创建方工具标识(统一接口归因) */
    ownerClient?: string;
    /** 指派的管理工具(接入名;与令牌持有者、GUI 同为分支属主;可经 vcs_branch_assign 改派/清空) */
    assignedClient?: string;
    /** 创建时的主干基点 commit(V1.28.0 起落库;合并前据此检测主干已回滚越过基点) */
    baseline?: string;
    /** 检查点缓存(V1.30.0 视图增量优化):上次视图拉取时的提交数;与 commits 不一致即重拉 */
    seenCommits?: number;
    checkpointCache?: WsBranchCheckpoint[];
    startedAt: string;
    lastActiveAt?: string;
}
/** temp 补救条目(无法提交时保全的 main/ 变化) */
export interface WsTempItem {
    name: string;
    summary: string;
    createdAt: string;
    baseline: string;
    files: number;
    source: AuditSource;
    /** 保存方工具标识(统一接口归因) */
    client?: string;
}
/** 合并冲突处理中状态(单槽:同一时刻只允许一个分支处于冲突解决期) */
export interface WsMergeInProgress {
    name: string;
    token: string;
    requirement: string;
    baseline: string;
    startedAt: string;
}
export interface WsRegistry {
    schema: 1;
    title: string;
    createdAt: string;
    versions: WsVersion[];
    inProgress: WsInProgress | null;
    /** 并行分支任务清单 */
    branches?: WsBranchTask[];
    /** 待处理 temp 条目 */
    temp?: WsTempItem[];
    /** 进行中的合并冲突解决(存在时主工作区写操作被拦) */
    mergeInProgress?: WsMergeInProgress | null;
}
export interface WsCommitOptions {
    summary: string;
    /** content=Y+1(默认,启发式兜底)/polish=Z+1/major=X+1 */
    bump?: Bump | "major";
    /** vcs_begin 签发的会话令牌(所有权校验:不匹配将拒绝,防止替其他会话收尾) */
    sessionToken?: string;
    /** 版本外排除:这些工作区相对路径的改动不入本版本,原样保留在工作区(用于把与本轮需求无关的半成品留在版本之外) */
    exclude?: string[];
}
export declare function wsCodeOf(round: number, content: number, polish: number): string;
/** 三类产物 + temp 补救区之外的工作区根文件都是"越界"的 */
export declare function isAllowedPath(rel: string): boolean;
export declare function wsLoadRegistry(repo: string): Promise<WsRegistry | null>;
export declare function wsAppendAudit(repo: string, tag: SourceLike, op: string, detail: string): Promise<void>;
/** 工作区根目录的越界文件(三类产物之外);删除记录(D)不算越界——收编搬移会产生合法删除 */
export declare function wsOffenders(repo: string): Promise<string[]>;
export declare const WS_WRITE_LOCK = ".vcs/write.lock";
export declare function wsInit(repo: string, opts: {
    title: string;
}, tag?: SourceLike): Promise<string>;
export interface WsBeginOptions {
    requirement: string;
    /** 遇到进行中版本时的显式接管:continue=沿用原需求/基线/半成品,换发令牌;fresh=半成品 stash 快照后按新需求开新版本 */
    takeover?: "continue" | "fresh";
}
export interface WsBeginResult {
    message: string;
    /** 会话令牌:vcs_commit 时经 sessionToken 传入;丢失可用 takeover="continue" 续作 */
    token: string;
}
export declare function wsBeginDetailed(repo: string, opts: WsBeginOptions, tag?: SourceLike): Promise<WsBeginResult>;
/** 兼容旧签名:只返回提示文本(令牌在 message 内) */
export declare function wsBegin(repo: string, opts: WsBeginOptions, tag?: SourceLike): Promise<string>;
export declare function wsCommit(repo: string, opts: WsCommitOptions & {
    source?: SourceLike;
}): Promise<string>;
export declare function wsRollback(repo: string, opts: {
    code: string;
    reason?: string;
    discardDirty?: boolean;
    /** 有进行中版本时必须显式传入:半成品 stash 快照后清除进行中状态,再执行回滚 */
    resolveInProgress?: "stash";
    source?: SourceLike;
}): Promise<string>;
/** 删除回滚时物化的项目副本(V<code>/项目副本/):只做副本清理,版本历史、tag 与 main/ 均不变;内容仍可随时恢复 */
export declare function wsDeleteCopy(repo: string, code: string, tag?: SourceLike): Promise<string>;
/** 为任意版本生成完整项目副本(浏览用快照;内容取自版本历史,不影响 main/) */
export declare function wsRestoreCopy(repo: string, code: string, tag?: SourceLike): Promise<string>;
export interface WsBranchBeginOptions {
    requirement: string;
    /** 短名(缺省自 requirement 生成;worktree 目录 .vcs/branch/<name>) */
    name?: string;
    /** 指派的管理工具(接入名,如 claude;清洗后为空视为未指派;仅实际建分支时落库) */
    assignee?: string;
    /** 基点(V1.29.0):从哪个版本开分支,V tag(如 V1.10.0)或任意 commit;缺省当前 HEAD */
    base?: string;
}
export declare function wsBranchBegin(repo: string, opts: WsBranchBeginOptions, tag?: SourceLike): Promise<WsBeginResult & {
    branch: string;
    worktree: string;
}>;
export declare function wsBranchCommit(repo: string, opts: {
    name: string;
    token?: string;
    summary: string;
    strict?: boolean;
}, tag?: SourceLike): Promise<string>;
export declare function wsBranchMerge(repo: string, opts: {
    name: string;
    token?: string;
    summary?: string;
    abort?: boolean;
    strict?: boolean;
    confirmStaleBase?: boolean;
}, tag?: SourceLike): Promise<string>;
export declare function wsBranchDiscard(repo: string, opts: {
    name: string;
    token?: string;
    force?: boolean;
}, tag?: SourceLike): Promise<string>;
/** 导入分支(V1.31.0):把仓库现存未登记的 vcs/task/* 孤儿分支重建工作树并纳入管理 */
export declare function wsBranchAdopt(repo: string, opts: {
    name: string;
    requirement: string;
    assignee?: string;
}, tag?: SourceLike): Promise<WsBeginResult & {
    branch: string;
    worktree: string;
}>;
/** 分支内回退(V1.29.0):把分支工作树回退到某个检查点(或回退上一检查点);未提交修改须 force 放弃 */
export declare function wsBranchRollback(repo: string, opts: {
    name: string;
    to?: string;
    token?: string;
    force?: boolean;
    strict?: boolean;
}, tag?: SourceLike): Promise<string>;
/** 主干合入分支(V1.29.0):把 main/ 最新内容合入分支工作树,长命分支对齐主干;也用于回滚后让分支适配新主干 */
export declare function wsBranchUpdate(repo: string, opts: {
    name: string;
    token?: string;
    strict?: boolean;
}, tag?: SourceLike): Promise<string>;
/** 改派/清空分支的管理工具(assignedClient);属主闸与 commit/merge/discard 一致 */
export declare function wsBranchAssign(repo: string, opts: {
    name: string;
    assignee?: string;
    token?: string;
    strict?: boolean;
}, tag?: SourceLike): Promise<string>;
export declare function wsTempSave(repo: string, opts: {
    summary: string;
    name?: string;
    sessionToken?: string;
}, tag?: SourceLike): Promise<string>;
export declare function wsTempApply(repo: string, opts: {
    name: string;
}, tag?: SourceLike): Promise<string>;
export declare function wsTempDiscard(repo: string, opts: {
    name: string;
}, tag?: SourceLike): Promise<string>;
/** 分支检查点提交(时间线版本图 B 节点数据源) */
export interface WsBranchCheckpoint {
    sha: string;
    /** 提交说明(subject 单行) */
    subject: string;
    /** 提交时间(本地 YYYY-MM-DD HH:mm) */
    date: string;
}
export interface WsBranchTaskView extends WsBranchTask {
    /** 分支领先 main/ 的提交数 */
    commits: number;
    /** 检查点提交清单(旧→新;时间线 B 节点与明细用) */
    checkpoints: WsBranchCheckpoint[];
    /** 分叉点的 V 版本号(git merge-base + describe 精确计算;无法定位时缺省) */
    baseVersion?: string;
    /** 工作树绝对路径(供 AI 工具与 GUI 直接定位分支目录) */
    worktreeAbs: string;
    /** 工作树未提交修改数(V1.29.0;丢弃/合并保护与 GUI 展示用) */
    dirty: number;
    stalled: boolean;
    stallMinutes: number;
}
export interface WsParallelView {
    branches: WsBranchTaskView[];
    temps: WsTempItem[];
    mergeInProgress: (WsMergeInProgress & {
        conflicts: string[];
    }) | null;
    /** 仓库现存但未登记的 vcs/task/* 分支(可经 vcs_branch_adopt 导入管理) */
    orphans: string[];
}
/** GUI 与 vcs_branches 共用:并行分支 + temp + 合并冲突状态的结构化清单 */
export declare function wsParallelView(repo: string): Promise<WsParallelView>;
/** 发布分支视图(GUI 顶栏切换器「发布」节,只读):publish/* 引用的快照信息,不进 vcs 工作分支体系 */
export interface WsPublishBranchView {
    /** publish/ 前缀后的短名,如 v1.34.1 */
    name: string;
    /** 完整引用名,如 publish/v1.34.1 */
    branch: string;
    /** 展示名:v1.34.1 → V1.34.1(非该形式原样保留) */
    version: string;
    sha: string;
    /** "YYYY-MM-DD HH:MM" */
    date: string;
    subject: string;
    /** 根一级文件清单;目录带斜尾(main/) */
    files: string[];
}
/** GUI 专用:publish/* 分支只读清单(顶栏切换器「发布」节)。发布分支不登记、不打 V 号、不可切换上下文 */
export declare function wsPublishBranches(repo: string): Promise<WsPublishBranchView[]>;
export declare function wsStatus(repo: string): Promise<string>;
/** 心跳:持有者携带令牌调用(如 vcs_status),刷新最近活跃时间;须持锁写,避免与 begin/commit 竞态 */
export declare function wsTouch(repo: string, sessionToken: string, tag?: SourceLike): Promise<boolean>;
export interface WsInProgressView extends WsInProgress {
    /** 距最近活跃是否已达停滞阈值 */
    stalled: boolean;
    stallMinutes: number;
}
/** GUI 用:进行中版本结构化视图(渲染端不再解析 status 文本) */
export declare function wsInProgressView(repo: string): Promise<WsInProgressView | null>;
/** 工作区占用概况(GUI「我的项目」卡片:哪个项目被谁占用、分支/temp 数、是否冲突中) */
export interface WsOccupancyView {
    inProgress: WsInProgressView | null;
    branchCount: number;
    tempCount: number;
    /** 合并冲突处理中 */
    mergeConflict: boolean;
}
/** 纯函数:从注册表算占用概况(无 IO,GUI 批量刷新项目列表时用) */
export declare function occupancyOfRegistry(reg: WsRegistry | null): WsOccupancyView;
export interface WsVersionView extends WsVersion {
    hasFolder: boolean;
    hasCopy: boolean;
}
export declare function wsListVersions(repo: string): Promise<WsVersionView[]>;
export declare function wsReadDoc(repo: string, code: string, which: "purpose" | "changes" | "workspaceLog"): Promise<string>;
/** 读取工作区某版本(或 "work"=当前 main)中某文件的内容(相对 main/ 的路径) */
export declare function wsReadFile(repo: string, ref: string, rel: string): Promise<string>;
/** 列出某版本(或 "work"=当前 main)中全部文件(相对 main/ 的路径) */
export declare function wsListFiles(repo: string, ref: string): Promise<string[]>;
/** main/ 相对某版本的 diff 全文(GUI 对比/详情用) */
export declare function wsDiff(repo: string, from: string, to: string | null, maxLines?: number): Promise<string>;
/** main/ 内两 ref 间的文件级差异(main/ 相对路径,与 wsListFiles 同口径):A=新增 M=改动 D=删除 */
export interface WsDiffFileEntry {
    file: string;
    status: "A" | "M" | "D";
}
export declare function wsDiffFiles(repo: string, from: string, to: string): Promise<WsDiffFileEntry[]>;
export interface MigrateOptions {
    title: string;
    /** 旧库路径(paper_versions/ 旧模型) */
    oldRepo: string;
    source?: SourceLike;
}
/**
 * 把旧模型论文库(paper_versions/ CN/EN/TEX 编号)迁移为 v3 工作区:
 * 旧库现役管理文件 → 新工作区 main/;旧版本按登记顺序映射为 V0.i.0 存档
 * (每个 V 文件夹带 更新目的.md + 改动日志.md,注明原编号);旧库原样保留。
 */
export declare function wsMigrateLegacy(newRepo: string, opts: MigrateOptions): Promise<string>;
export interface WsAnalyzeReport {
    dir: string;
    isWorkspace: boolean;
    title?: string;
    versionCount: number;
    latest?: string;
    hasGit: boolean;
    totalFiles: number;
    totalBytes: number;
    byType: {
        type: string;
        count: number;
        bytes: number;
    }[];
    topEntries: {
        name: string;
        type: "dir" | "file";
        bytes: number;
    }[];
    plan: string[];
}
/** 对任意文件夹做"深入分析":结构与体量盘点 + 转为标准工作区的整理方案 */
export declare function wsAnalyze(dir: string): Promise<WsAnalyzeReport>;
