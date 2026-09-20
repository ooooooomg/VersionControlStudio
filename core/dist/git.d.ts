/** 二进制安全版:返回原始 Buffer(如 git show 读取图片) */
export declare function gitBuffer(repo: string, args: string[]): Promise<Buffer>;
/** 运行 git 子进程(关闭 quotepath 转义,保证中文路径按字面返回) */
export declare function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string>;
export interface StatusEntry {
    xy: string;
    path: string;
    origPath?: string;
}
/** 解析 `git status --porcelain -z` 输出 */
export declare function parsePorcelainZ(out: string): StatusEntry[];
export declare function isRepo(repo: string): Promise<boolean>;
export declare function head(repo: string): Promise<string>;
/** commit 是否存在于本仓(任意 ref 可达性由调用方另行判断;此处只验对象存在) */
export declare function commitExists(repo: string, sha: string): Promise<boolean>;
export declare function currentBranch(repo: string): Promise<string>;
export declare function statusPorcelain(repo: string, paths: string[]): Promise<StatusEntry[]>;
/** 支持 "*.ext"、字面名(按 basename)与仓库相对完整路径三类排除匹配 */
export declare function matchesExcludePattern(repoRelPath: string, patterns: string[]): boolean;
export declare function addPaths(repo: string, paths: string[]): Promise<void>;
/** 读取某 ref(或 "work"=工作区)中单个文件的内容 */
export declare function showFile(repo: string, ref: string, filePath: string): Promise<string>;
/** 列出某 ref 中全部文件(相对路径);ref="work" 用 ls-files -o 之外的已跟踪+未跟踪合并由调用方处理 */
export declare function lsTreeFiles(repo: string, ref: string, pathspec?: string): Promise<string[]>;
/**
 * 提交。paths 提供时做"范围提交"(pathspec commit):只提交这些路径的变更,
 * 用户在暂存区里的其他无关内容原样保留,不被卷入 —— 隔离承诺的提交级保障。
 * 实测:commit 正确支持 :(exclude) pathspec;但"匹配不到任何文件"的正向
 * pathspec 会让整条命令 fatal,因此调用方应先用 filterExistingPathspecs 过滤。
 */
export declare function commit(repo: string, message: string, paths?: string[]): Promise<string>;
/** 过滤掉"无匹配"的正向 pathspec(已跟踪 / HEAD 中存在 / 磁盘上存在 任一即保留) */
export declare function filterExistingPathspecs(repo: string, positives: string[]): Promise<string[]>;
export declare function tagExists(repo: string, name: string): Promise<boolean>;
export declare function tagList(repo: string): Promise<string[]>;
export declare function createTag(repo: string, name: string, message: string): Promise<void>;
export declare function diffStat(repo: string, from: string, to: string | null, paths: string[]): Promise<string>;
export declare function diffFull(repo: string, from: string, to: string | null, paths: string[], maxLines: number): Promise<string>;
/** 把 ref 中管理路径的内容检出到工作区+索引(回滚用;不改历史)。逐路径容错。 */
export declare function checkoutPaths(repo: string, ref: string, paths: string[]): Promise<void>;
