import { execFile } from "node:child_process";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
/** 二进制安全版:返回原始 Buffer(如 git show 读取图片) */
export async function gitBuffer(repo, args) {
    return new Promise((resolve, reject) => {
        execFile("git", ["-c", "core.quotepath=off", ...args], { cwd: repo, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout) => {
            if (err)
                reject(err);
            else
                resolve(stdout);
        });
    });
}
const MAX_BUFFER = 128 * 1024 * 1024;
/** 运行 git 子进程(关闭 quotepath 转义,保证中文路径按字面返回) */
export async function git(repo, args, env = {}) {
    const { stdout } = await execFileP("git", ["-c", "core.quotepath=off", ...args], {
        cwd: repo,
        env: { ...process.env, ...env },
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
    });
    return stdout;
}
/** 解析 `git status --porcelain -z` 输出 */
export function parsePorcelainZ(out) {
    const chunks = out.split("\0").filter((c) => c.length > 0);
    const entries = [];
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const xy = c.slice(0, 2);
        const path = c.slice(3);
        const entry = { xy, path };
        if (xy[0] === "R" || xy[0] === "C") {
            i += 1; // 重命名/复制的下一个 \0 段是原路径
            entry.origPath = chunks[i];
        }
        entries.push(entry);
    }
    return entries;
}
export async function isRepo(repo) {
    try {
        const t = await git(repo, ["rev-parse", "--git-dir"]);
        return t.trim().length > 0;
    }
    catch {
        return false;
    }
}
export async function head(repo) {
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
}
/** commit 是否存在于本仓(任意 ref 可达性由调用方另行判断;此处只验对象存在) */
export async function commitExists(repo, sha) {
    try {
        await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
        return true;
    }
    catch {
        return false;
    }
}
export async function currentBranch(repo) {
    const b = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return b === "HEAD" ? "" : b;
}
export async function statusPorcelain(repo, paths) {
    if (paths.length === 0)
        return [];
    const positives = paths.filter((p) => !p.startsWith(":"));
    const excludes = paths.filter((p) => p.startsWith(":"));
    if (positives.length === 0)
        return [];
    const out = await git(repo, [
        "status",
        "--porcelain",
        "-z",
        "--",
        ...paths,
    ]);
    // 后置过滤:纯排除 pathspec 语义是"其余全部",若正向 pathspec 均无匹配,
    // git 会把仓库所有文件列出来——这里按正向前缀兜底过滤,保证只返回管理路径
    return parsePorcelainZ(out).filter((e) => positives.some((p) => p === "." ||
        p.includes("*") ||
        p.includes("?") ||
        e.path === p ||
        e.path.startsWith(p.replaceAll("\\", "/") + "/")));
}
/** 支持 "*.ext"、字面名(按 basename)与仓库相对完整路径三类排除匹配 */
export function matchesExcludePattern(repoRelPath, patterns) {
    const norm = repoRelPath.replaceAll("\\", "/");
    const base = norm.split("/").pop() ?? "";
    for (const p of patterns) {
        if (p.startsWith("*")) {
            if (base.endsWith(p.slice(1)))
                return true;
        }
        else if (base === p || base === p.replace(/\/$/, "")) {
            return true;
        }
        else if (norm === p.replaceAll("\\", "/").replace(/\/$/, "")) {
            return true; // 完整相对路径(如 main/a/b.ico)精确排除
        }
    }
    return false;
}
export async function addPaths(repo, paths) {
    if (paths.length === 0)
        return;
    const positives = paths.filter((p) => !p.startsWith(":"));
    const excludes = paths
        .filter((p) => p.startsWith(":"))
        .map((p) => p.replace(/^:\(exclude\)/, ""));
    if (positives.length === 0)
        return;
    // 注意:实测 git add 携带 :(exclude) pathspec 会静默不 stage 任何文件,
    // 纯排除 pathspec 更是等价于"添加全部"。因此 add 只用正向路径,
    // 之后把命中排除模式的暂存文件 reset 出去
    for (const p of positives) {
        try {
            await git(repo, ["add", "-A", "--", p]);
        }
        catch {
            /* pathspec 无匹配(目录尚不存在),跳过 */
        }
    }
    if (excludes.length > 0) {
        const staged = (await git(repo, ["diff", "--cached", "--name-only"]))
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        const bad = staged.filter((f) => matchesExcludePattern(f, excludes));
        if (bad.length > 0) {
            await git(repo, ["reset", "-q", "--", ...bad]);
        }
    }
}
/** 读取某 ref(或 "work"=工作区)中单个文件的内容 */
export async function showFile(repo, ref, filePath) {
    const safe = filePath.replaceAll("\\", "/");
    if (ref === "work") {
        const { readFile } = await import("node:fs/promises");
        return readFile(path.join(repo, safe), "utf8");
    }
    return git(repo, ["show", `${ref}:${safe}`]);
}
/** 列出某 ref 中全部文件(相对路径);ref="work" 用 ls-files -o 之外的已跟踪+未跟踪合并由调用方处理 */
export async function lsTreeFiles(repo, ref, pathspec) {
    const args = ["ls-tree", "-r", "--name-only", ref];
    if (pathspec)
        args.push("--", pathspec);
    const out = await git(repo, args);
    return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * 提交。paths 提供时做"范围提交"(pathspec commit):只提交这些路径的变更,
 * 用户在暂存区里的其他无关内容原样保留,不被卷入 —— 隔离承诺的提交级保障。
 * 实测:commit 正确支持 :(exclude) pathspec;但"匹配不到任何文件"的正向
 * pathspec 会让整条命令 fatal,因此调用方应先用 filterExistingPathspecs 过滤。
 */
export async function commit(repo, message, paths) {
    const args = ["commit", "-m", message];
    if (paths && paths.length > 0)
        args.push("--", ...paths);
    await git(repo, args);
    return head(repo);
}
/** 过滤掉"无匹配"的正向 pathspec(已跟踪 / HEAD 中存在 / 磁盘上存在 任一即保留) */
export async function filterExistingPathspecs(repo, positives) {
    const out = [];
    for (const p of positives) {
        const listed = (await git(repo, ["ls-files", "--", p])).trim();
        if (listed) {
            out.push(p);
            continue;
        }
        let inHead = "";
        try {
            inHead = (await git(repo, ["ls-tree", "HEAD", "--", p])).trim();
        }
        catch {
            /* 空仓库无 HEAD */
        }
        if (inHead) {
            out.push(p);
            continue;
        }
        try {
            await stat(path.join(repo, p));
            out.push(p);
        }
        catch {
            /* 无匹配,丢弃 */
        }
    }
    return out;
}
export async function tagExists(repo, name) {
    const out = await git(repo, ["tag", "-l", name]);
    return out.trim() === name;
}
export async function tagList(repo) {
    const out = await git(repo, ["tag", "-l"]);
    return out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
export async function createTag(repo, name, message) {
    await git(repo, ["tag", "-a", name, "-m", message]);
}
export async function diffStat(repo, from, to, paths) {
    const args = ["diff", "--stat=120", "-M", from];
    if (to)
        args.push(to);
    if (paths.length > 0)
        args.push("--", ...paths);
    return (await git(repo, args)).trim();
}
export async function diffFull(repo, from, to, paths, maxLines) {
    const args = ["diff", "-M", from];
    if (to)
        args.push(to);
    if (paths.length > 0)
        args.push("--", ...paths);
    const out = await git(repo, args);
    const lines = out.split("\n");
    if (lines.length <= maxLines)
        return out.trimEnd();
    return (lines.slice(0, maxLines).join("\n") +
        `\n... (diff 共 ${lines.length} 行,已截断至 ${maxLines} 行;可用 paper_diff 指定更小路径范围)`);
}
/** 把 ref 中管理路径的内容检出到工作区+索引(回滚用;不改历史)。逐路径容错。 */
export async function checkoutPaths(repo, ref, paths) {
    const errors = [];
    for (const p of paths) {
        try {
            await git(repo, ["checkout", ref, "--", p]);
        }
        catch (e) {
            errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (errors.length > 0 && errors.length === paths.length) {
        throw new Error(`检出 ${ref} 全部路径失败:\n${errors.join("\n")}`);
    }
}
