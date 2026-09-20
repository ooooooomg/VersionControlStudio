/**
 * 工作区版本模型 v3(通用项目版):
 * 一个项目 = 一个工作区文件夹,内部只允许三类产物:
 *   1) main/            —— 用户真正的项目(AI/用户只在这里改)
 *   2) V X.Y.Z/         —— 每版本子文件夹:更新目的.md + 改动日志.md(回滚时物化项目副本)
 *   3) 工作区日志.md     —— 用户需求与 AI 改动总账
 * 另有 .vcs/(工具内部状态:registry + audit,git 管理,不属三类但必不可少)。
 * 版本号 V{X.Y.Z}:X=里程碑/重大重构,Y=功能迭代,Z=微调;commit 时定版。
 * git 管历史省空间;回滚 = main 回到旧内容 + 旧版完整副本物化到对应 V 文件夹。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { git, isRepo, head, commitExists, statusPorcelain, parsePorcelainZ, addPaths, commit, filterExistingPathspecs, tagExists, tagList, createTag, diffFull, checkoutPaths, gitBuffer, } from "./git.js";
export const WS_MAIN_DIR = "main";
/** 工作区路径解析:显式参数 > 环境变量 PAPER_VERSION_REPO > 当前目录 */
export function resolveRepo(explicit) {
    const repo = explicit ?? process.env.PAPER_VERSION_REPO ?? process.cwd();
    return path.resolve(repo);
}
export function normTag(tag = "api") {
    return typeof tag === "string" ? { source: tag } : { source: tag.source, client: tag.client };
}
/** 审计/锁/展示用的来源标注:传输通道[:工具],如 mcp-http:claude */
export function tagLabel(tag) {
    const t = normTag(tag);
    return t.client ? `${t.source}:${t.client}` : t.source;
}
export const WS_MAIN = "main";
export const WS_LOG = "工作区日志.md";
export const WS_DIR = ".vcs";
export const WS_REGISTRY = `${WS_DIR}/registry.json`;
export const WS_AUDIT = `${WS_DIR}/audit.log`;
/** 并行分支工作树根(git worktree,共享对象库不复制历史) */
export const WS_BRANCH_DIR = `${WS_DIR}/branch`;
/** temp 补救区:无法提交时保全 main/ 变化 */
export const WS_TEMP_DIR = "temp";
function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
;
export function wsCodeOf(round, content, polish) {
    return `V${round}.${content}.${polish}`;
}
/** 三类产物 + temp 补救区之外的工作区根文件都是"越界"的 */
export function isAllowedPath(rel) {
    const p = rel.replaceAll("\\", "/");
    if (p === ".gitignore" || p === ".gitattributes" || p === ".zcodeignore")
        return true; // 仓库机械文件(含 ZCode 会话忽略表)
    if (p === WS_LOG || p.startsWith(WS_DIR + "/") || p === WS_DIR)
        return true;
    if (p === WS_MAIN || p.startsWith(WS_MAIN + "/"))
        return true;
    if (p === WS_TEMP_DIR || p.startsWith(WS_TEMP_DIR + "/"))
        return true;
    return /^V\d+\.\d+\.\d+\//.test(p) || /^V\d+\.\d+\.\d+$/.test(p);
}
export async function wsLoadRegistry(repo) {
    try {
        return JSON.parse(await fs.readFile(path.join(repo, WS_REGISTRY), "utf8"));
    }
    catch {
        return null;
    }
}
async function wsSaveRegistry(repo, reg) {
    const dir = path.join(repo, WS_DIR);
    await fs.mkdir(dir, { recursive: true });
    // 原子写:临时文件 + rename,避免进程中断/并发写产生半截 JSON(V1.9.2 设置文件同款修法)
    const tmp = path.join(dir, `registry.tmp-${process.pid}-${Date.now()}`);
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
    await fs.rename(tmp, path.join(repo, WS_REGISTRY));
}
export async function wsAppendAudit(repo, tag, op, detail) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    await fs.mkdir(path.join(repo, WS_DIR), { recursive: true });
    await fs.appendFile(path.join(repo, WS_AUDIT), `${ts} | ${tagLabel(tag)} | ${op} | ${detail.replaceAll("\n", " ⏎ ").slice(0, 400)}\n`, "utf8");
}
/** 分支工作树守卫(V1.28.0):worktree 检出自带过期 registry 快照,会被误当独立工作区(嵌套分支/幽灵定版/tag 污染) */
async function assertNotBranchWorktree(repo) {
    const norm = repo.replaceAll("\\", "/");
    if (norm.includes(`${WS_BRANCH_DIR}/`)) {
        throw new Error(`${repo} 是并行分支的工作树,不能作为工作区操作:请改用主工作区根目录路径` +
            `(分支内的修改请走 vcs_branch_commit 检查点,而非 vcs_begin/vcs_commit 定版)`);
    }
    // git worktree 链接工作树的 .git 是文件而非目录,同样拒绝(覆盖目录被改名/搬移的漏网路径)
    try {
        const st = await fs.lstat(path.join(repo, ".git"));
        if (st.isFile()) {
            throw new Error(`${repo} 是 git 链接工作树(疑似并行分支工作树),不能作为工作区操作:请改用主工作区根目录路径`);
        }
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("工作区操作"))
            throw err;
        /* .git 不存在等:交由后续 registry 检查报错 */
    }
}
async function wsRequire(repo) {
    await assertNotBranchWorktree(repo);
    const reg = await wsLoadRegistry(repo);
    if (!reg) {
        throw new Error(`${repo} 不是本工具的工作区:请先调用 vcs_init 创建工作区结构(main/ + 工作区日志.md + .vcs/)`);
    }
    return reg;
}
/** 工作区根目录的越界文件(三类产物之外);删除记录(D)不算越界——收编搬移会产生合法删除 */
export async function wsOffenders(repo) {
    const entries = await statusPorcelain(repo, ["."]);
    return entries
        .filter((e) => !e.xy.includes("D"))
        .map((e) => e.path)
        .filter((p) => !isAllowedPath(p));
}
function nextCode(last, bump) {
    const parse = (code) => {
        const m = /^V(\d+)\.(\d+)\.(\d+)$/.exec(code);
        return { round: Number(m[1]), content: Number(m[2]), polish: Number(m[3]) };
    };
    if (!last)
        return "V1.0.0"; // 初始版本一律 V1.0.0
    const v = parse(last.code);
    if (bump === "major")
        return `V${v.round + 1}.0.0`;
    if (bump === "polish")
        return `V${v.round}.${v.content}.${v.polish + 1}`;
    return `V${v.round}.${v.content + 1}.0`;
}
// ---------------------------------------------------------------- init
/** 写操作按仓库路径串行化:消除同进程并发(HTTP 并行工具调用与 GUI 同时操作)的读-改-写竞态 */
const repoLocks = new Map();
function withRepoLock(repo, fn) {
    const key = path.resolve(repo).toLowerCase();
    const prev = repoLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    repoLocks.set(key, run.catch(() => undefined));
    return run;
}
// ---------------------------------------------------------------- 跨进程写锁
// git index.lock 同款思路:O_EXCL 原子建锁文件 + 持有者信息;持有者崩溃残留由
// 后续写者按「pid 已死 或 持锁超时」判定 stale 后接管(从不静默自动删除)。
// 锁活性用心跳(mtime 周期性刷新)维持,长操作不会被误判 stale。
export const WS_WRITE_LOCK = `${WS_DIR}/write.lock`;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
const LOCK_TOUCH_MS = 30_000;
/** 本进程已持有的锁(可重入:migrate 外层持锁后内部还会走 wsInitUnlocked 同仓操作) */
const heldWriteLocks = new Map();
function lockKey(repo) {
    return path.resolve(repo).toLowerCase();
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err?.code === "EPERM"; // EPERM=存在但属其他用户
    }
}
async function readLockInfo(repo) {
    try {
        return JSON.parse(await fs.readFile(path.join(repo, WS_WRITE_LOCK), "utf8"));
    }
    catch {
        return null; // 不存在或半截 JSON
    }
}
async function lockAgeMs(repo) {
    try {
        const st = await fs.stat(path.join(repo, WS_WRITE_LOCK));
        return Date.now() - st.mtimeMs;
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
/** 锁文件/分支工作树/temp 是临时或免提交产物,不进版本库:写入仓库本地 .git/info/exclude(不被跟踪,新旧工作区通用) */
async function ensureGitExclude(repo) {
    const entries = [WS_WRITE_LOCK, `${WS_BRANCH_DIR}/`, `${WS_TEMP_DIR}/`];
    try {
        const p = path.join(repo, ".git", "info", "exclude");
        let cur = "";
        try {
            cur = await fs.readFile(p, "utf8");
        }
        catch {
            /* 无文件则新建 */
        }
        const have = new Set(cur.split("\n").map((l) => l.trim()));
        const missing = entries.filter((e) => !have.has(e));
        if (missing.length > 0) {
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.appendFile(p, `\n${missing.join("\n")}\n`, "utf8");
        }
    }
    catch {
        /* 裸仓等异常场景忽略:最坏情况被当作普通未跟踪文件 */
    }
}
async function acquireWriteLock(repo, source) {
    const key = lockKey(repo);
    const held = heldWriteLocks.get(key);
    if (held) {
        held.depth += 1;
        return;
    }
    await fs.mkdir(path.join(repo, WS_DIR), { recursive: true });
    await ensureGitExclude(repo);
    const lockPath = path.join(repo, WS_WRITE_LOCK);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const fh = await fs.open(lockPath, "wx"); // O_EXCL:原子创建,撞锁即 EEXIST
            const info = { pid: process.pid, source, acquiredAt: nowStr() };
            await fh.writeFile(JSON.stringify(info), "utf8");
            await fh.close();
            const timer = setInterval(() => {
                void fs.utimes(lockPath, new Date(), new Date()).catch(() => { });
            }, LOCK_TOUCH_MS);
            timer.unref?.();
            heldWriteLocks.set(key, { depth: 1, timer });
            return;
        }
        catch (err) {
            if (err?.code !== "EEXIST")
                throw err;
        }
        const info = await readLockInfo(repo);
        const age = await lockAgeMs(repo);
        const stale = !info || !pidAlive(info.pid) || age > LOCK_STALE_MS;
        if (stale) {
            await fs.rm(lockPath, { force: true });
            await wsAppendAudit(repo, source, "ws_lock_takeover", `holder_pid=${info?.pid ?? "?"} holder_source=${info?.source ?? "?"} age_ms=${Number.isFinite(age) ? Math.round(age) : "?"}`);
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(`另一进程正在写入本工作区(持有者 pid=${info?.pid ?? "?"},来源 ${info?.source ?? "?"},已持锁约 ${Math.round(age / 1000)}s)。` +
                `稍后重试;若确认该进程已退出,可删除 ${WS_WRITE_LOCK} 后重试`);
        }
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
}
async function releaseWriteLock(repo) {
    const key = lockKey(repo);
    const held = heldWriteLocks.get(key);
    if (!held)
        return;
    held.depth -= 1;
    if (held.depth > 0)
        return;
    clearInterval(held.timer);
    heldWriteLocks.delete(key);
    await fs.rm(path.join(repo, WS_WRITE_LOCK), { force: true }).catch(() => { });
}
/** 全部写操作的统一入口:进程内串行(repoLock)→ 跨进程互斥(write.lock)→ 释放 */
function withWorkspace(repo, tag, fn) {
    return withRepoLock(repo, async () => {
        await acquireWriteLock(repo, tagLabel(tag));
        try {
            return await fn();
        }
        finally {
            await releaseWriteLock(repo);
        }
    });
}
// ---------------------------------------------------------------- 会话所有权
function newSessionToken() {
    return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
function ipActiveAt(ip) {
    return ip.lastActiveAt ?? ip.startedAt;
}
function ipOwnerLine(ip) {
    const who = ip.ownerClient ? `${ip.ownerSource ?? "旧版工具"} · 工具 ${ip.ownerClient}` : (ip.ownerSource ?? "旧版工具");
    return (`另一会话(来源 ${who},开始于 ${ip.startedAt},最近活跃 ${ipActiveAt(ip)})` +
        `正在进行:需求「${ip.requirement}」`);
}
/** 收尾/回滚的所有权闸:令牌不匹配(或旧版登记无令牌)一律拒绝,堵住"替他人会话强行收尾"的路径 */
function requireOwnership(ip, sessionToken) {
    if (!ip.owner) {
        throw new Error(`${ipOwnerLine(ip)}。该进行中版本由旧版工具登记(无会话令牌),不能直接收尾:` +
            `请确认对方已停止后用 vcs_begin takeover="continue" 接管,再行处理`);
    }
    if (sessionToken !== ip.owner) {
        throw new Error(`${ipOwnerLine(ip)}。请勿替其他会话收尾或回滚:等待其完成;` +
            `本会话即持有者时,请携带 vcs_begin 返回的会话令牌(sessionToken)重试;` +
            `确认对方已停止则用 vcs_begin takeover="continue"|"fresh" 接管`);
    }
}
/** 半成品快照:仅 stash main/(工作树本来干净时不产生 stash),接管/回滚不丢数据 */
async function stashMain(repo, message) {
    await git(repo, ["stash", "push", "--include-untracked", "-m", message, "--", WS_MAIN]);
}
/** 短名:小写字母/数字/连字符,取自 name 或 requirement,长度受限 */
function slugify(input, fallbackSeed) {
    const raw = (input || fallbackSeed)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)
        .replace(/-+$/g, "");
    return raw || `${fallbackSeed}-${crypto.randomUUID().slice(0, 4)}`;
}
/** 合并冲突处理期守卫:主工作区一切写操作让位于冲突解决 */
function assertNoMerge(reg, op) {
    if (reg.mergeInProgress) {
        throw new Error(`合并冲突处理中(分支 ${reg.mergeInProgress.name},需求「${reg.mergeInProgress.requirement}」):` +
            `AI 修复 main/ 内冲突标记后再次调用 vcs_branch_merge 完成定版,或传 abort:true 放弃合并;期间不能${op}`);
    }
}
/** 从注册表找分支任务 */
function findBranch(reg, name) {
    const t = (reg.branches ?? []).find((b) => b.name === name);
    if (!t) {
        throw new Error(`并行分支不存在:${name}(用 vcs_branches 查看现有分支;分支名在创建时确定)`);
    }
    return t;
}
/** 指派工具(接入名)清洗:小写、仅 [a-z0-9._-]、≤40;清洗后为空视为未指派 */
function normAssignee(v) {
    const s = (v ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "")
        .slice(0, 40);
    return s || undefined;
}
/**
 * 分支属主判定:令牌持有者(创建会话)/ 指派工具(assignedClient)/ GUI(用户亲自授权)三元属主。
 * 命中属主 → 返回放行依据;否则返回 via:"third"(是否放行由调用方 strict 档决定,deny 为拒绝文案)。
 */
function branchAccess(t, sessionToken, tag) {
    const tg = normTag(tag);
    if (sessionToken !== undefined && sessionToken === t.token)
        return { via: "token" };
    if (tg.source === "gui")
        return { via: "gui" };
    if (t.assignedClient && tg.client && tg.client.toLowerCase() === t.assignedClient) {
        return { via: "assigned" };
    }
    const who = t.ownerClient ? `${t.ownerSource} · 工具 ${t.ownerClient}` : t.ownerSource;
    const assignee = t.assignedClient ? `,指派「${t.assignedClient}」` : "";
    const caller = tg.client ?? tg.source;
    return {
        via: "third",
        warn: `⚠ 分支属主提醒:分支 ${t.name}(创建于 ${t.startedAt},来源 ${who}${assignee})的本次操作来自非属主「${caller}」,已放行并写入审计;该分支若需独占,请用户改派指派工具或对该工具启用 strict 档`,
        deny: `拒绝:并行分支 ${t.name} 不属于你(创建于 ${t.startedAt},来源 ${who}${assignee}),需求「${t.requirement}」。合法操作人=令牌持有者${assignee}、GUI 用户;请携带创建时返回的会话令牌,或由用户在 GUI / 指派工具处操作(strict 档)`,
    };
}
/** 分支操作权限闸:strict=true 时非属主一律拒绝;默认放行并返回提醒行(空串=属主操作无提醒) */
function requireBranchAccess(t, opts, tag) {
    const r = branchAccess(t, opts.token, tag);
    if (r.via === "third") {
        if (opts.strict)
            throw new Error(r.deny);
        return r;
    }
    return { via: r.via, warn: "" };
}
/** 令牌属主对照(S4):令牌正确但调用工具与登记的工具不一致 → 提示性警告(不拒绝,防令牌在多工具间误串) */
function ownershipWarn(ownerClient, client) {
    if (!client || !ownerClient || ownerClient === client)
        return "";
    return `⚠ 令牌属主对照:该令牌由工具「${ownerClient}」取得,当前调用方是「${client}」——若非同一工具续作,请核对是否拿错了其他工具的会话令牌`;
}
export function wsInit(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsInitUnlocked(repo, opts, tag));
}
async function wsInitUnlocked(repo, opts, tag = "api") {
    if (!(await isRepo(repo))) {
        await git(repo, ["init", "-b", "master"]);
    }
    // 缺身份的机器/临时目录:落本地兜底身份,否则 commit 会 fatal
    for (const [k, v] of [
        ["user.name", "PVC Studio"],
        ["user.email", "pvc-studio@local"],
    ]) {
        try {
            await git(repo, ["config", k]);
        }
        catch {
            await git(repo, ["config", k, v]);
        }
    }
    if (await wsLoadRegistry(repo)) {
        throw new Error(`${repo} 已是工作区(${WS_REGISTRY} 存在),禁止重复初始化`);
    }
    await fs.mkdir(path.join(repo, WS_MAIN), { recursive: true });
    // 收编:main 为空且根目录已有内容(如现有项目文件夹)时,把内容移入 main/
    {
        const rootItems = await fs.readdir(repo, { withFileTypes: true });
        const keep = new Set([".git", WS_DIR, WS_MAIN, WS_LOG, ".gitignore", ".gitattributes", ".zcodeignore"]);
        const movable = rootItems.filter((it) => !keep.has(it.name));
        if ((await fs.readdir(path.join(repo, WS_MAIN))).length === 0 && movable.length > 0) {
            for (const it of movable) {
                await fs.rename(path.join(repo, it.name), path.join(repo, WS_MAIN, it.name)).catch(() => { });
            }
        }
    }
    await fs.writeFile(path.join(repo, WS_MAIN, ".gitkeep"), "", "utf8");
    await fs.mkdir(path.join(repo, WS_DIR), { recursive: true });
    const reg = {
        schema: 1,
        title: opts.title,
        createdAt: nowStr(),
        versions: [],
        inProgress: null,
    };
    await wsSaveRegistry(repo, reg);
    await fs.writeFile(path.join(repo, WS_LOG), [
        `# 工作区日志 —— ${opts.title}`,
        "",
        `> 由 version-control-studio(v3 工作区模型)自动维护。记录用户需求与 AI 对项目的每次改动。`,
        "",
        `## ${nowStr()} 工作区创建`,
        `- 初始化工作区:main/ 存放项目;此后每个版本为 V X.Y.Z 文件夹(更新目的.md + 改动日志.md)。`,
        "",
    ].join("\n"), "utf8");
    await addPaths(repo, [WS_MAIN, WS_LOG, WS_DIR]);
    await commit(repo, `vcs: 工作区初始化 —— ${opts.title}`, [
        ...(await filterExistingPathspecs(repo, [WS_MAIN, WS_LOG, WS_DIR])),
    ]);
    await wsAppendAudit(repo, tag, "ws_init", `title=${opts.title}`);
    return [
        `工作区已创建:${repo}`,
        `结构:main/(项目主体)+ 工作区日志.md + .vcs/(工具状态)`,
        `使用:AI 通过 vcs_begin(记录用户需求)→ 修改 main/ → vcs_commit(生成 V 文件夹并打 tag);回滚用 vcs_rollback。`,
    ].join("\n");
}
export function wsBeginDetailed(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBeginUnlocked(repo, opts, tag));
}
/** 兼容旧签名:只返回提示文本(令牌在 message 内) */
export function wsBegin(repo, opts, tag = "api") {
    return wsBeginDetailed(repo, opts, tag).then((r) => r.message);
}
async function wsBeginUnlocked(repo, opts, tag) {
    const t = normTag(tag);
    const source = t.source;
    const client = t.client;
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "开始新版本");
    const ip = reg.inProgress;
    if (ip && !opts.takeover) {
        throw new Error(`${ipOwnerLine(ip)}。请勿替其他会话收尾或回滚;等待其完成,` +
            `或确认其已停止后用 vcs_begin takeover="continue"|"fresh" 接管`);
    }
    if (!ip && opts.takeover) {
        throw new Error("当前没有进行中的版本,无需接管:直接 vcs_begin 即可");
    }
    // 显式接管 continue:原 code/需求/基线/半成品全部沿用,只换发令牌并刷新活跃时间
    if (opts.takeover === "continue" && ip) {
        const token = newSessionToken();
        ip.owner = token;
        ip.ownerSource = source;
        ip.ownerClient = client;
        ip.lastActiveAt = nowStr();
        await wsSaveRegistry(repo, reg);
        await wsAppendAudit(repo, t, "ws_takeover", `mode=continue code=${ip.code} requirement="${ip.requirement.slice(0, 120)}"`);
        return {
            token,
            message: [
                `已接管进行中版本 ${ip.code}(会话令牌已换发,半成品原样保留在 main/)`,
                `用户需求:${ip.requirement}`,
                `基线:${ip.baseline.slice(0, 10)};继续修改后 vcs_commit 携带新令牌(sessionToken)收尾`,
            ].join("\n"),
        };
    }
    // 显式接管 fresh:前任半成品 stash 快照(可找回),再按新需求干净开始
    if (opts.takeover === "fresh" && ip) {
        await stashMain(repo, `vcs-takeover: ${ip.code} ${ip.requirement.slice(0, 60)}`);
        await wsAppendAudit(repo, t, "ws_takeover", `mode=fresh stashed_code=${ip.code} requirement="${ip.requirement.slice(0, 100)}"`);
        reg.inProgress = null;
    }
    if (!opts.requirement.trim())
        throw new Error("requirement 必填:记录用户对本轮修改的需求");
    const last = reg.versions[reg.versions.length - 1] ?? null;
    const baseline = await head(repo);
    const token = newSessionToken();
    reg.inProgress = {
        code: nextCode(last, "content"),
        requirement: opts.requirement.trim(),
        baseline,
        startedAt: nowStr(),
        owner: token,
        ownerSource: source,
        ownerClient: client,
        lastActiveAt: nowStr(),
    };
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, t, "ws_begin", `requirement="${opts.requirement.trim().slice(0, 120)}"`);
    return {
        token,
        message: [
            `已开始新版本(占位 ${reg.inProgress.code},commit 时按级别定版)`,
            `用户需求:${opts.requirement.trim()}`,
            `会话令牌:${token} —— vcs_commit 时经 sessionToken 传入;令牌丢失可用 vcs_begin takeover="continue" 续作`,
            `现在可以在 main/ 内修改项目;完成后 vcs_commit 生成 V 文件夹。注意:工作区根目录下只允许 main/、V*、工作区日志.md、.vcs/,越界文件会导致 commit 被拒。`,
        ].join("\n"),
    };
}
// ---------------------------------------------------------------- commit
export function wsCommit(repo, opts) {
    return withWorkspace(repo, opts.source ?? "api", () => wsCommitUnlocked(repo, opts));
}
async function wsCommitUnlocked(repo, opts) {
    const t = normTag(opts.source ?? "api");
    const source = t.source;
    const client = t.client;
    const reg = await wsRequire(repo);
    const ip = reg.inProgress;
    if (!ip) {
        if (reg.mergeInProgress) {
            assertNoMerge(reg, "收尾提交(没有进行中的版本)");
        }
        throw new Error("没有进行中的版本:先 vcs_begin 记录用户需求");
    }
    assertNoMerge(reg, "收尾提交");
    requireOwnership(ip, opts.sessionToken);
    const oWarn = ownershipWarn(ip.ownerClient, client);
    if (!opts.summary.trim())
        throw new Error("summary 必填:本轮 AI 做了什么改动");
    // 强制约束:工作区内只允许三类产物
    const offenders = await wsOffenders(repo);
    if (offenders.length > 0) {
        throw new Error(`工作区存在三类产物之外的越界文件,拒绝提交(本工具约束 AI 只产生:main/、V X.Y.Z/、工作区日志.md):\n` +
            offenders.slice(0, 10).map((p) => `  ${p}`).join("\n") +
            (offenders.length > 10 ? `\n  ... 共 ${offenders.length} 个` : "") +
            `\n请把项目文件移入 main/,或删除无关文件。`);
    }
    const dirty = await statusPorcelain(repo, ["."]);
    // 版本外排除:归一化后把命中路径的改动留在工作区(不入本版本),用于隔离与本轮需求无关的半成品
    const excludes = [
        ...new Set((opts.exclude ?? [])
            .map((p) => p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
            .filter((p) => p.length > 0)),
    ];
    const exPathspecs = excludes.map((p) => `:(exclude)${p}`);
    const isExcluded = (p) => {
        const n = p.replaceAll("\\", "/");
        return excludes.some((e) => n === e || n.startsWith(e + "/"));
    };
    // 空版本判定:.vcs/registry.json 等登记簿在 begin 后必然是脏的,不能算内容变更;
    // 用了 exclude 时按 main/ 实际内容判空(排除后一无所剩即拒绝);
    // 未用 exclude 时保持旧行为(新建项目等文档性初始版本仍可收尾)
    const mainDirty = dirty.filter((e) => {
        const n = e.path.replaceAll("\\", "/");
        return n.startsWith(WS_MAIN + "/") && !isExcluded(n);
    });
    if (excludes.length > 0 && mainDirty.length === 0) {
        throw new Error("按 exclude 排除后 main/ 已无内容变更,拒绝生成空版本;请调整 exclude 或先完成修改");
    }
    if (dirty.length === 0) {
        throw new Error(`自基线 ${ip.baseline.slice(0, 10)} 以来无任何修改,拒绝空版本`);
    }
    const last = reg.versions[reg.versions.length - 1] ?? null;
    const bump = opts.bump ?? "content";
    const code = nextCode(last, bump);
    // 乐观校验:注册表可能已被另一进程(stdio-bridge 等独立进程)推进;在任何文件副作用前取消
    const fresh = await wsLoadRegistry(repo);
    if (!fresh ||
        fresh.versions.length !== reg.versions.length ||
        fresh.versions[fresh.versions.length - 1]?.code !== last?.code ||
        JSON.stringify(fresh.inProgress) !== JSON.stringify(reg.inProgress)) {
        throw new Error(`注册表已被其他进程修改(磁盘最新 ${fresh?.versions[fresh.versions.length - 1]?.code ?? "无"}),` +
            `本次提交取消;请重新 vcs_status 确认状态后再试`);
    }
    const vDir = path.join(repo, `V${code.slice(1)}`);
    // V 文件夹两文档(分点格式:需求/摘要由 AI 按「1. 2. 3.」书写,面板直接渲染分点)
    await fs.mkdir(vDir, { recursive: true });
    const reqLines = ip.requirement.trim().split("\n").map((l) => `  ${l.trimEnd()}`);
    await fs.writeFile(path.join(vDir, "更新目的.md"), [
        `# 更新目的 —— ${code}`,
        "",
        `- 日期:${nowStr()}`,
        `- 用户需求:`,
        ...reqLines,
        `- 级别:${bump === "major" ? "里程碑(X+1)" : bump === "polish" ? "微调(Z+1)" : "功能迭代(Y+1)"}`,
        "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(vDir, "改动日志.md"), [`# 改动日志 —— ${code}(相对上一版 ${last?.code ?? "—"})`, "", `${opts.summary.trim()}`, ""].join("\n"), "utf8");
    // 追加全局工作区日志
    await fs.appendFile(path.join(repo, WS_LOG), [
        `## ${nowStr()} ${code}`,
        `- 用户需求:${ip.requirement}`,
        `- AI 改动:${opts.summary.trim()}`,
        `- 明细:V${code.slice(1)}/ 更新目的.md · 改动日志.md`,
        "",
    ].join("\n"), "utf8");
    const entry = {
        code,
        purpose: ip.requirement,
        changes: opts.summary.trim(),
        date: nowStr(),
        source,
        client,
    };
    const versionsSnapshot = reg.versions.slice();
    const ipSnapshot = reg.inProgress;
    let committed = false;
    try {
        reg.versions.push(entry);
        reg.inProgress = null;
        await wsSaveRegistry(repo, reg);
        await addPaths(repo, [".", ...exPathspecs]);
        const paths = await filterExistingPathspecs(repo, [
            WS_MAIN,
            WS_LOG,
            WS_DIR,
            `V${code.slice(1)}`,
        ]);
        const sha = await commit(repo, `vcs: ${code} — ${opts.summary.trim()}`, [
            ...paths,
            ...exPathspecs,
        ]);
        committed = true;
        if (await tagExists(repo, code))
            throw new Error(`tag ${code} 已存在`);
        await createTag(repo, code, `${ip.requirement}\n\n${opts.summary.trim()}`);
        const remain = (await wsOffenders(repo)).length;
        return [
            `版本 ${code} 已收尾:commit ${sha.slice(0, 10)} + tag ${code}`,
            `V${code.slice(1)}/ 已生成:更新目的.md + 改动日志.md;工作区日志.md 已追加`,
            `级别:${bump === "major" ? "里程碑" : bump === "polish" ? "微调" : "功能迭代"} | 变更文件:${mainDirty.length}`,
            ...(excludes.length > 0
                ? [`已按 exclude 排除 ${excludes.length} 个路径(改动保留在工作区,未入本版本):\n  ${excludes.join("\n  ")}`]
                : []),
            ...(remain > 0 ? [`注意:仍有 ${remain} 个越界文件未纳管`] : []),
            ...(oWarn ? [oWarn] : []),
        ].join("\n");
    }
    catch (err) {
        if (!committed) {
            // 仅当磁盘注册表仍是我们此前写入的状态、且 HEAD 仍停在基线(即无其他进程
            // 完成提交)时才回退;若已被其他进程推进,保持不动,避免覆盖他人已登记的版本
            const now = await wsLoadRegistry(repo);
            const tail = now?.versions[now.versions.length - 1]?.code;
            const headNow = await head(repo).catch(() => "");
            if (now && tail === code && now.inProgress === null && headNow === ip.baseline) {
                reg.versions = versionsSnapshot;
                reg.inProgress = ipSnapshot;
                await wsSaveRegistry(repo, reg);
            }
        }
        throw err;
    }
}
/** 回滚与恢复副本共用的目标内容集:rel(相对 main/)→ 取内容函数(本地 tag 优先,迁移版本取来源库) */
async function collectTargetFiles(repo, target, code) {
    const tags = new Set(await tagList(repo));
    const isLocal = tags.has(code);
    const useOrigin = !isLocal && !!target?.originRepo && !!target.origin && !!target.originIncludes?.length;
    if (!isLocal && !useOrigin) {
        throw new Error(`版本 ${code} 不存在或缺少可回滚内容(无 tag 且无迁移来源)`);
    }
    const files = [];
    if (isLocal) {
        const tagFiles = (await git(repo, ["ls-tree", "-r", "--name-only", code, "--", WS_MAIN]))
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((f) => (f.startsWith(WS_MAIN + "/") ? f.slice(WS_MAIN.length + 1) : f))
            .filter((f) => f && f !== ".gitkeep");
        for (const rel of tagFiles) {
            files.push({
                rel,
                read: () => gitBuffer(repo, ["show", `${code}:${WS_MAIN}/${rel}`]),
            });
        }
        return files;
    }
    const oldTag = target.origin;
    const inc = target.originIncludes;
    const all = (await git(target.originRepo, ["ls-tree", "-r", oldTag]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("160000"))
        .map((l) => l.slice(l.indexOf("\t") + 1))
        .filter(Boolean);
    const rels = all.filter((f) => inc.some((ic) => {
        const norm = ic.replaceAll("\\", "/");
        return f === norm || f.startsWith(norm + "/") || norm.includes("*");
    }));
    for (const rel of rels) {
        files.push({
            rel,
            read: () => gitBuffer(target.originRepo, ["show", `${oldTag}:${rel}`]),
        });
    }
    return files;
}
/** 把目标内容物化为完整项目副本到 V<code>/项目副本/,返回文件数 */
async function writeCopy(repo, code, targetFiles) {
    const copyDir = path.join(repo, `V${code.slice(1)}`, "项目副本");
    await fs.rm(copyDir, { recursive: true, force: true });
    await fs.mkdir(copyDir, { recursive: true });
    for (const f of targetFiles) {
        const dest = path.join(copyDir, f.rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await f.read());
    }
    return targetFiles.length;
}
/** 只针对 V<code>/ 的范围提交(副本管理):不碰 main/ 与用户暂存区,历史不改写 */
async function commitCopyHousekeeping(repo, code, message) {
    const vRel = `V${code.slice(1)}`;
    await addPaths(repo, [vRel]);
    return commit(repo, message, [vRel]);
}
export function wsRollback(repo, opts) {
    return withWorkspace(repo, opts.source ?? "api", () => wsRollbackUnlocked(repo, opts));
}
async function wsRollbackUnlocked(repo, opts) {
    const t = normTag(opts.source ?? "api");
    const source = t.source;
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "回滚");
    let stashedInProgress = false;
    if (reg.inProgress) {
        const ip = reg.inProgress;
        if (opts.resolveInProgress !== "stash") {
            throw new Error(`${ipOwnerLine(ip)}。回滚前需先处理进行中版本:持有者先 vcs_commit 收尾;` +
                `或显式传 resolveInProgress:"stash" 把半成品快照进 git stash 后回滚`);
        }
        await stashMain(repo, `vcs-rollback: ${ip.code} ${ip.requirement.slice(0, 60)}`);
        await wsAppendAudit(repo, t, "ws_takeover", `mode=stash-for-rollback code=${ip.code} requirement="${ip.requirement.slice(0, 100)}"`);
        reg.inProgress = null;
        await wsSaveRegistry(repo, reg);
        // registry 的进行中清除是本次操作的合法变更,不再受 dirty 守卫拦截
        stashedInProgress = true;
    }
    const code = opts.code.startsWith("V") ? opts.code : `V${opts.code}`;
    const dirty = await statusPorcelain(repo, ["."]);
    const offenders = dirty.map((e) => e.path).filter((p) => !isAllowedPath(p));
    if (offenders.length > 0) {
        throw new Error(`工作区有越界文件,先清理再回滚:\n${offenders.slice(0, 8).join("\n")}`);
    }
    // 主干口径(V1.28.0):回滚只重写 main/;.vcs 簿记(每次操作必脏)随回滚版本自动收编,不构成「会覆盖的修改」
    const mainDirty = dirty.filter((e) => e.path === WS_MAIN || e.path.startsWith(WS_MAIN + "/"));
    if (mainDirty.length > 0 && !opts.discardDirty && !stashedInProgress) {
        throw new Error(`主干 main/ 有 ${mainDirty.length} 处未收尾修改,回滚会覆盖;确认请传 discardDirty:true` +
            (dirty.length > mainDirty.length
                ? `(另有 ${dirty.length - mainDirty.length} 处 .vcs 簿记变更,随回滚版本自动收编,无需处理)`
                : ""));
    }
    const target = reg.versions.find((v) => v.code === code);
    const isLocal = (new Set(await tagList(repo))).has(code);
    if (!isLocal && !(!!target?.originRepo && !!target.origin && !!target.originIncludes?.length)) {
        throw new Error(`版本 ${code} 不存在或缺少可回滚内容(无 tag 且无迁移来源)`);
    }
    const targetFiles = await collectTargetFiles(repo, target, code);
    const mainRoot = path.join(repo, WS_MAIN);
    if (isLocal) {
        // ① checkout 该版本 main/
        await checkoutPaths(repo, code, [WS_MAIN]);
    }
    // ② 删除 main/ 中不在目标集的文件
    const want = new Set(targetFiles.map((f) => f.rel.replaceAll("\\", "/")));
    const trackedNow = (await git(repo, ["ls-files", "--", WS_MAIN]))
        .split("\n")
        .map((s) => s.trim())
        .map((f) => (f.startsWith(WS_MAIN + "/") ? f.slice(WS_MAIN.length + 1) : f))
        .filter(Boolean);
    const untrackedNow = (await git(repo, ["ls-files", "-o", "--exclude-standard", "--", WS_MAIN]))
        .split("\n")
        .map((s) => s.trim())
        .map((f) => (f.startsWith(WS_MAIN + "/") ? f.slice(WS_MAIN.length + 1) : f))
        .filter(Boolean);
    const root2 = path.resolve(repo);
    for (const rel of [...trackedNow, ...untrackedNow]) {
        if (want.has(rel.replaceAll("\\", "/")))
            continue;
        const abs = path.resolve(repo, WS_MAIN, rel);
        if (abs.startsWith(root2 + path.sep))
            await fs.rm(abs, { force: true });
    }
    // ③ 写入目标内容到 main/
    for (const f of targetFiles) {
        const dest = path.join(mainRoot, f.rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await f.read());
    }
    // ④ 项目副本物化到该版本子文件夹
    const copyCount = await writeCopy(repo, code, targetFiles);
    if (target)
        target.materialized = true;
    await wsSaveRegistry(repo, reg);
    // ④ 回滚本身记录为一个新版本(main 已变)
    await addPaths(repo, ["."]);
    const last = reg.versions[reg.versions.length - 1] ?? null;
    const newCode = nextCode(last, "content");
    const vDir = path.join(repo, `V${newCode.slice(1)}`);
    await fs.mkdir(vDir, { recursive: true });
    await fs.writeFile(path.join(vDir, "更新目的.md"), `# 更新目的 —— ${newCode}\n\n- 日期:${nowStr()}\n- 用户需求:回滚到 ${code}${opts.reason ? `(${opts.reason})` : ""}\n`, "utf8");
    await fs.writeFile(path.join(vDir, "改动日志.md"), [
        `# 改动日志 —— ${newCode}`,
        "",
        `1. main/ 已回滚到 ${code} 的内容,后续版本以此为主线继续。`,
        `2. 完整项目副本已物化到 V${code.slice(1)}/项目副本/(不用时可在版本详情删除)。`,
        "",
    ].join("\n"), "utf8");
    await fs.appendFile(path.join(repo, WS_LOG), `## ${nowStr()} ${newCode}\n- 用户需求:回滚到 ${code}\n- AI 改动:main/ 回到 ${code} 内容;副本物化于 V${code.slice(1)}/项目副本/\n\n`, "utf8");
    const entry = {
        code: newCode,
        purpose: `回滚到 ${code}${opts.reason ? `(${opts.reason})` : ""}`,
        changes: `main/ 回到 ${code} 内容;副本物化于 V${code.slice(1)}/项目副本/`,
        date: nowStr(),
        source,
    };
    reg.versions.push(entry);
    await wsSaveRegistry(repo, reg);
    await addPaths(repo, ["."]);
    const paths = await filterExistingPathspecs(repo, [
        WS_MAIN,
        WS_LOG,
        WS_DIR,
        `V${code.slice(1)}`,
        `V${newCode.slice(1)}`,
    ]);
    const sha = await commit(repo, `vcs: ${newCode} — 回滚到 ${code}`, paths);
    if (await tagExists(repo, newCode))
        throw new Error(`tag ${newCode} 已存在`);
    await createTag(repo, newCode, `回滚到 ${code}`);
    await wsAppendAudit(repo, source, "ws_rollback", `to=${code} as=${newCode}`);
    return [
        `已回滚:main/ 回到 ${code} 的内容(commit ${sha.slice(0, 10)},新版本号 ${newCode})`,
        `main/ 现在就是 ${code} 的内容 —— 后续版本将以此为主线继续;副本已物化:V${code.slice(1)}/项目副本/(共 ${copyCount} 个文件,不用时可在版本详情里删除)`,
        `历史未改写:${code} 的 tag 与记录保持原样`,
        // 回滚×分支感知(V1.28.0):列出现存分支,提示其基点可能已被回滚越过
        ...((reg.branches?.length ?? 0) > 0
            ? [
                `注意:现存并行分支 ${reg.branches.map((b) => `${b.name}(基点 ${b.baseline?.slice(0, 10) ?? "未知"})`).join("、")} —— ` +
                    `若分支基点已被本次回滚越过,直接合并会把旧变更叠加到回滚后的内容上;请核对后在分支管理页丢弃或待 vcs_branch_update(下一版)对齐后再合并`,
            ]
            : []),
    ].join("\n");
}
// ---------------------------------------------------------------- 副本管理(删除 / 恢复)
/** 删除回滚时物化的项目副本(V<code>/项目副本/):只做副本清理,版本历史、tag 与 main/ 均不变;内容仍可随时恢复 */
export function wsDeleteCopy(repo, code, tag = "api") {
    return withWorkspace(repo, tag, () => wsDeleteCopyUnlocked(repo, code, tag));
}
async function wsDeleteCopyUnlocked(repo, code, tag) {
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "删除副本");
    const v = code.startsWith("V") ? code : `V${code}`;
    const target = reg.versions.find((x) => x.code === v);
    if (!target)
        throw new Error(`版本 ${v} 不存在`);
    const vCopyRel = `V${v.slice(1)}/项目副本`;
    const copyDir = path.join(repo, `V${v.slice(1)}`, "项目副本");
    const tracked = (await git(repo, ["ls-files", "--", vCopyRel]))
        .split("\n")
        .filter((s) => s.trim()).length;
    let has = false;
    try {
        await fs.stat(copyDir);
        has = true;
    }
    catch {
        /* 无副本 */
    }
    if (!has && tracked === 0) {
        throw new Error(`版本 ${v} 没有物化的项目副本(未曾回滚到此版本,或副本已删除)`);
    }
    // 安全阀:内容必须仍可从版本历史找回(本地 tag 或迁移来源)才允许删除
    const tags = new Set(await tagList(repo));
    const recoverable = tags.has(v) || (!!target.originRepo && !!target.origin && !!target.originIncludes?.length);
    if (!recoverable) {
        throw new Error(`版本 ${v} 既无 git tag 也无迁移来源,删除副本将无法找回内容,拒绝删除`);
    }
    await fs.rm(copyDir, { recursive: true, force: true });
    await commitCopyHousekeeping(repo, v, `vcs: 删除 ${v} 的项目副本(副本管理,历史与 tag 不变)`);
    await wsAppendAudit(repo, tag, "ws_copy_delete", `code=${v} files=${tracked}`);
    return [
        `已删除 ${v}/项目副本/(涉及 ${tracked} 个文件)`,
        `版本内容不受影响:tag ${v} 仍保存该版本完整 main/ 内容,main/ 与工作区历史未改写`,
        `需要再次浏览时,可在该版本详情用「恢复副本」(vcs_restore_copy)重新物化`,
    ].join("\n");
}
/** 为任意版本生成完整项目副本(浏览用快照;内容取自版本历史,不影响 main/) */
export function wsRestoreCopy(repo, code, tag = "api") {
    return withWorkspace(repo, tag, () => wsRestoreCopyUnlocked(repo, code, tag));
}
async function wsRestoreCopyUnlocked(repo, code, tag) {
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "生成副本");
    const v = code.startsWith("V") ? code : `V${code}`;
    const target = reg.versions.find((x) => x.code === v);
    if (!target)
        throw new Error(`版本 ${v} 不存在`);
    const copyDir = path.join(repo, `V${v.slice(1)}`, "项目副本");
    let exists = false;
    try {
        await fs.stat(copyDir);
        exists = true;
    }
    catch {
        /* 无副本 */
    }
    if (exists)
        throw new Error(`版本 ${v} 已有项目副本,无需重复生成(如需重建请先删除)`);
    const targetFiles = await collectTargetFiles(repo, target, v);
    const count = await writeCopy(repo, v, targetFiles);
    await commitCopyHousekeeping(repo, v, `vcs: 生成 ${v} 的项目副本(副本管理,历史与 tag 不变)`);
    await wsAppendAudit(repo, tag, "ws_copy_restore", `code=${v} files=${count}`);
    return [
        `已生成 ${v}/项目副本/(共 ${count} 个文件,取自版本历史)`,
        `main/ 未改动;生成/删除副本都会以副本管理提交留痕,版本历史不改写`,
    ].join("\n");
}
export function wsBranchBegin(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchBeginUnlocked(repo, opts, tag));
}
async function wsBranchBeginUnlocked(repo, opts, tag) {
    const t = normTag(tag);
    const source = t.source;
    const client = t.client;
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "创建并行分支");
    if (!opts.requirement?.trim())
        throw new Error("requirement 必填:记录用户对本轮修改的需求");
    // 永远创建真实分支(V1.27.0 起):分支与主干状态无关,与 git 语义一致——
    // 旧版「主空闲时回落为普通 begin」会让 GUI 显式建分支变成 main 上的隐式任务,已废弃
    const base = slugify(opts.name ?? "", "task");
    reg.branches = reg.branches ?? [];
    let name = base;
    for (let i = 2; reg.branches.some((b) => b.name === name); i++)
        name = `${base}-${i}`;
    const branchName = `vcs/task/${name}`;
    const worktreeRel = `${WS_BRANCH_DIR}/${name}`;
    const worktreeAbs = path.join(repo, worktreeRel);
    await git(repo, ["worktree", "prune"]);
    const existsRef = (await git(repo, ["branch", "--list", branchName])).trim();
    if (existsRef) {
        // 残留收养(V1.28.0):ref 存在而注册表无此分支 = 历史清理中断的孤儿(begin 崩溃窗口 / 旧版清理顺序缺陷)。
        // 旧逻辑直接拒绝并建议 discard,而 discard 按注册表查找必然「不存在」——名字永久死锁;现自动收养清理后继续。
        await fs.rm(worktreeAbs, { recursive: true, force: true }).catch(() => { });
        await git(repo, ["worktree", "prune"]);
        await git(repo, ["branch", "-D", branchName]);
        await wsAppendAudit(repo, t, "ws_branch_begin", `adopted_orphan name=${name} ref=${branchName}`);
    }
    await fs.mkdir(path.dirname(worktreeAbs), { recursive: true });
    await ensureGitExclude(repo);
    // 基点(V1.29.0):默认当前 HEAD;可指定历史版本节点(V tag 或 commit),从那里长出分支
    let baseRef = "HEAD";
    if (opts.base?.trim()) {
        const ref = opts.base.trim().startsWith("V") ? opts.base.trim() : opts.base.trim();
        const ok = await git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).catch(() => "");
        if (!ok.trim())
            throw new Error(`基点 ${ref} 不存在:请给有效的 V 版本号(如 V1.10.0)或 commit sha`);
        baseRef = ref;
    }
    await git(repo, ["worktree", "add", "-b", branchName, worktreeAbs, baseRef]);
    const baseline = await head(repo);
    const token = newSessionToken();
    const assignedClient = normAssignee(opts.assignee);
    reg.branches.push({
        name,
        branch: branchName,
        worktree: worktreeRel,
        requirement: opts.requirement.trim(),
        token,
        ownerSource: source,
        ownerClient: client,
        ...(assignedClient ? { assignedClient } : {}),
        baseline,
        startedAt: nowStr(),
        lastActiveAt: nowStr(),
    });
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, t, "ws_branch_begin", `name=${name} branch=${branchName} baseline=${baseline.slice(0, 10)}${assignedClient ? ` assigned=${assignedClient}` : ""} requirement="${opts.requirement.trim().slice(0, 100)}"`);
    return {
        token,
        branch: branchName,
        worktree: worktreeRel,
        message: [
            `已创建并行分支 ${branchName}(独立工作树,与 main/ 互不干扰;无论主干是否空闲都可建分支)`,
            `用户需求:${opts.requirement.trim()}`,
            ...(baseRef !== "HEAD" ? [`基点:${baseRef}(分支从该历史版本长出,不含其后的主干演进)`] : []),
            ...(assignedClient ? [`管理工具:${assignedClient}(该工具无需令牌即可在本分支 commit/merge/discard)`] : []),
            `工作树:${worktreeRel} —— 之后所有文件修改都在这个目录内进行,不要动 main/(属于另一会话)`,
            `会话令牌:${token} —— vcs_branch_commit / vcs_branch_merge 时经 token 传入`,
            `流程:在工作树内修改 → vcs_branch_commit 做检查点(不占 V 版本号)→ 完成后 vcs_branch_merge 合并定版(合并前主工作区须先收尾);node_modules 不随检出,构建/测试验证在合并后的主工作区统一做`,
        ].join("\n"),
    };
}
export function wsBranchCommit(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchCommitUnlocked(repo, opts, tag));
}
async function wsBranchCommitUnlocked(repo, opts, tag) {
    const t = normTag(tag);
    const reg = await wsRequire(repo);
    const b = findBranch(reg, opts.name);
    const acc = requireBranchAccess(b, opts, tag);
    const oWarn = ownershipWarn(b.ownerClient, t.client);
    if (!opts.summary?.trim())
        throw new Error("summary 必填:本检查点做了什么");
    // 挂起合并保护(V1.28.0):合并的 MERGE_HEAD 固定为挂起时刻的分支头,此间的检查点不会进入定版,
    // 且定版后工作树会被删除——提交即静默丢失,必须拒绝
    if (reg.mergeInProgress?.name === b.name) {
        throw new Error(`分支 ${b.name} 的合并冲突正在挂起处理,期间分支冻结(此时提交的检查点不会进入合并版本,且合并完成后将丢失)。` +
            `请先在 main/ 内修复冲突标记后 vcs_branch_merge 完成定版,或 abort:true 放弃合并后再继续开发本分支`);
    }
    const wt = path.join(repo, b.worktree);
    const dirty = await statusPorcelain(wt, ["."]);
    if (dirty.length === 0)
        throw new Error("工作树无修改,拒绝空检查点");
    await addPaths(wt, ["."]);
    // 检查点提交方标注(V1.30.0):尾附 [接入名],合并后 git log/时间线仍可辨是谁提交的
    const who = t.client ? ` [${t.client}]` : t.source === "gui" ? " [人工]" : "";
    const sha = await commit(wt, `vcs-branch: ${b.name} — ${opts.summary.trim()}${who}`);
    b.lastActiveAt = nowStr();
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, t, "ws_branch_commit", `name=${b.name} sha=${sha.slice(0, 10)} files=${dirty.length} via=${acc.via}`);
    return [
        `分支 ${b.name} 检查点已提交:${sha.slice(0, 10)}(${dirty.length} 处变更,不占 V 版本号)`,
        `继续修改或完成后 vcs_branch_merge 合并(合并前主工作区须先收尾)`,
        ...(acc.warn ? [acc.warn] : []),
        ...(oWarn ? [oWarn] : []),
    ].join("\n");
}
export function wsBranchMerge(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchMergeUnlocked(repo, opts, tag));
}
async function wsBranchMergeUnlocked(repo, opts, tag) {
    const tg = normTag(tag);
    const reg = await wsRequire(repo);
    const t = findBranch(reg, opts.name);
    // 放弃合并:干净回退主工作区(merge --abort 恢复到合并前)
    if (opts.abort) {
        const acc = requireBranchAccess(t, opts, tag);
        if (!reg.mergeInProgress || reg.mergeInProgress.name !== t.name) {
            throw new Error(`分支 ${t.name} 没有进行中的合并冲突,无需放弃`);
        }
        await git(repo, ["merge", "--abort"]);
        reg.mergeInProgress = null;
        await wsSaveRegistry(repo, reg);
        await wsAppendAudit(repo, tg, "ws_branch_merge", `mode=abort name=${t.name} via=${acc.via}`);
        return `已放弃 ${t.branch} 的合并:main/ 恢复到合并前状态;分支与其工作树保留,可继续开发或 vcs_branch_discard 丢弃`;
    }
    // 冲突解决后的继续定版
    if (reg.mergeInProgress) {
        if (reg.mergeInProgress.name !== t.name) {
            throw new Error(`另一分支 ${reg.mergeInProgress.name} 的合并冲突尚未处理完(单槽):先完成或放弃它`);
        }
        const acc = requireBranchAccess(t, opts, tag);
        // 越界闸(V1.28.0):与普通 vcs_commit 同一纪律,merge 状态下只能全量提交,必须先把关
        const offenders = await wsOffenders(repo);
        if (offenders.length > 0) {
            throw new Error(`工作区存在越界文件,拒绝合并定版(全量提交会把它们卷入版本历史):\n${offenders.slice(0, 10).map((p) => `  ${p}`).join("\n")}\n` +
                `先移出工作区或纳入 main/ 后重试`);
        }
        // 先把用户/AI 已修复的冲突文件暂存,再检查是否还有未解决项
        await addPaths(repo, ["."]);
        const conflicts = (await git(repo, ["diff", "--name-only", "--diff-filter=U"])).trim();
        if (conflicts) {
            throw new Error(`仍有未解决冲突(${conflicts.split("\n").length} 处):\n${conflicts.split("\n").slice(0, 10).map((c) => `  ${c}`).join("\n")}\n` +
                `在 main/ 内修复冲突标记(<<<<<<<)后再次调用 vcs_branch_merge 完成定版,或 abort:true 放弃`);
        }
        return finalizeBranchMerge(repo, reg, t, opts.summary, tag, acc);
    }
    // 全新合并:主工作区必须完全空闲(合并点串行化)
    const acc = requireBranchAccess(t, opts, tag);
    if (reg.inProgress) {
        throw new Error(`主工作区有进行中的版本(${reg.inProgress.code}):先由持有者 vcs_commit 收尾再合并(合并点串行化,避免混入半成品)`);
    }
    const dirty = await statusPorcelain(repo, [WS_MAIN]);
    if (dirty.length > 0) {
        throw new Error(`main/ 有 ${dirty.length} 处未收尾修改:先收尾或保存 temp 后再合并`);
    }
    const ahead = parseInt((await git(repo, ["rev-list", "--count", `HEAD..${t.branch}`])).trim(), 10) || 0;
    if (ahead === 0) {
        throw new Error(`分支 ${t.name} 相对 main/ 无新提交,无需合并(若不要了可 vcs_branch_discard 丢弃)`);
    }
    // 分支工作树脏警告(V1.28.0):合并定版将删除工作树,未提交修改会随树蒸发——先提示明确数量
    const wtDirty = await statusPorcelain(path.join(repo, t.worktree), ["."]);
    if (wtDirty.length > 0) {
        throw new Error(`分支 ${t.name} 的工作树有 ${wtDirty.length} 处未提交修改,合并定版将删除工作树、这些修改会丢失。` +
            `先在分支工作树内 vcs_branch_commit 存检查点,或放弃这些修改后再合并`);
    }
    // 回滚×分支感知(V1.28.0):本仓回滚不改写历史(HEAD 仍是基点后代),祖先判定探不到。
    // 用注册表判定:merge-base 之后的版本条目里存在「回滚到 …」即说明分叉后主干发生过回滚——
    // 直接合并会把按旧基点计算的变更叠加到回滚后的内容上,产生语义错配;要求显式确认后才放行
    if (t.baseline && (await commitExists(repo, t.baseline))) {
        const mb = (await git(repo, ["merge-base", "HEAD", t.branch])).trim();
        if (mb) {
            let baseCode = "";
            try {
                const d = (await git(repo, ["describe", "--abbrev=0", "--match=V*", mb])).trim();
                if (/^V\d+\.\d+\.\d+$/.test(d))
                    baseCode = d;
            }
            catch {
                /* merge-base 早于任何 V tag:视为无回滚记录 */
            }
            if (baseCode) {
                const idx = reg.versions.findIndex((v) => v.code === baseCode);
                const afterBase = idx >= 0 ? reg.versions.slice(idx + 1) : [];
                const rollbackInBetween = afterBase.filter((v) => v.purpose.startsWith("回滚到"));
                if (rollbackInBetween.length > 0 && !opts.confirmStaleBase) {
                    throw new Error(`检测到分支 ${t.name} 分叉后主干发生过回滚(${rollbackInBetween.map((v) => `${v.code}:${v.purpose}`).join("、")}):` +
                        `直接合并会把按旧基点计算的变更叠加到回滚后的内容上,产生语义错配的版本。\n` +
                        `选项:① vcs_branch_discard 丢弃该分支;② 确认要合并请带 confirmStaleBase:true(自行核对分支内容仍适配当前主干)`);
                }
            }
        }
    }
    // 越界闸(V1.28.0):merge --no-commit 后必须全量提交,越界文件会在 finalize 被卷入,提前把关
    const offenders = await wsOffenders(repo);
    if (offenders.length > 0) {
        throw new Error(`工作区存在越界文件,拒绝合并(全量定版会把它们卷入版本历史):\n${offenders.slice(0, 10).map((p) => `  ${p}`).join("\n")}\n` +
            `先移出工作区或纳入 main/ 后重试`);
    }
    const baseline = await head(repo);
    let mergeOk = false;
    try {
        await git(repo, ["merge", "--no-ff", "--no-commit", t.branch]);
        mergeOk = true;
    }
    catch {
        mergeOk = false;
    }
    if (!mergeOk) {
        const conflicts = (await git(repo, ["diff", "--name-only", "--diff-filter=U"])).trim();
        if (!conflicts)
            throw new Error("合并失败且无冲突记录,请检查 git 状态后重试");
        reg.mergeInProgress = {
            name: t.name,
            token: t.token,
            requirement: t.requirement,
            baseline,
            startedAt: nowStr(),
        };
        await wsSaveRegistry(repo, reg);
        await wsAppendAudit(repo, tg, "ws_branch_merge", `mode=conflict name=${t.name} conflicts=${conflicts.split("\n").length} via=${acc.via}`);
        return [
            `合并 ${t.branch} 产生冲突(${conflicts.split("\n").length} 处),已挂起等待解决:`,
            ...conflicts.split("\n").slice(0, 10).map((c) => `  ${c}`),
            `处理:AI 在 main/ 内修复冲突标记后,再次调用 vcs_branch_merge {name:"${t.name}", token} 完成定版;`,
            `放弃:vcs_branch_merge {name:"${t.name}", abort:true} 干净回退(分支保留)`,
            ...(acc.warn ? [acc.warn] : []),
        ].join("\n");
    }
    return finalizeBranchMerge(repo, reg, t, opts.summary, tag, acc);
}
/** 合并收尾:生成 V 版本(V 文件夹+日志+commit+tag)并清理分支工作树;须持锁,冲突已解决或无冲突 */
async function finalizeBranchMerge(repo, reg, t, summary, tag, acc) {
    const tg = normTag(tag);
    const source = tg.source;
    const client = tg.client;
    const mergeState = reg.mergeInProgress;
    const last = reg.versions[reg.versions.length - 1] ?? null;
    const code = nextCode(last, "content");
    const changes = summary?.trim() || `合并并行分支 ${t.branch}(${mergeState ? "冲突已解决" : "无冲突"})`;
    const vDir = path.join(repo, `V${code.slice(1)}`);
    await fs.mkdir(vDir, { recursive: true });
    const mergeReqLines = t.requirement.trim().split("\n").map((l) => `  ${l.trimEnd()}`);
    await fs.writeFile(path.join(vDir, "更新目的.md"), [
        `# 更新目的 —— ${code}`,
        "",
        `- 日期:${nowStr()}`,
        `- 用户需求:`,
        ...mergeReqLines,
        `- 级别:功能迭代(Y+1)`,
        "",
    ].join("\n"), "utf8");
    // 合并痕迹(V1.29.0):分支迭代过程写入改动日志,合并后 B 节点虽消失、过程仍可追溯
    let checkpointLines = [];
    try {
        const raw = await git(repo, ["log", "--pretty=%h%x00%s%x00%ad", "--date=format-local:%Y-%m-%d %H:%M", `HEAD..${t.branch}`]);
        const cps = raw.split("\n").filter((l) => l.trim()).reverse();
        if (cps.length > 0) {
            checkpointLines = ["", `### 分支 ${t.name} 迭代明细(${cps.length} 个检查点,旧→新)`, ...cps.map((l) => {
                    const [h = "", s = "", d = ""] = l.split("\x00");
                    return `- ${d} ${h} ${s}`;
                })];
        }
    }
    catch {
        /* 检查点清单获取失败不影响定版 */
    }
    await fs.writeFile(path.join(vDir, "改动日志.md"), [`# 改动日志 —— ${code}(相对上一版 ${last?.code ?? "—"})`, "", changes, ...checkpointLines, ""].join("\n"), "utf8");
    await fs.appendFile(path.join(repo, WS_LOG), [
        `## ${nowStr()} ${code}`,
        `- 用户需求:${t.requirement}(并行分支 ${t.name} 合并)`,
        `- AI 改动:${changes}`,
        `- 明细:V${code.slice(1)}/ 更新目的.md · 改动日志.md`,
        "",
    ].join("\n"), "utf8");
    const entry = {
        code,
        purpose: `${t.requirement}(并行分支 ${t.name})`,
        changes,
        date: nowStr(),
        source,
        client,
        mergedFrom: t.name,
    };
    // merge 状态(--no-commit)下 git 禁止 pathspec 部分提交:必须全量提交。
    // 越界闸(V1.28.0):全量提交会把根目录越界文件永久卷入版本,提前把关(冲突续作路径已查,这里兜底无冲突路径)
    if (!mergeState) {
        const offenders = await wsOffenders(repo);
        if (offenders.length > 0) {
            throw new Error(`工作区存在越界文件,拒绝合并定版:\n${offenders.slice(0, 10).map((p) => `  ${p}`).join("\n")}\n先移出工作区或纳入 main/ 后重试`);
        }
    }
    // tip 校验(V1.28.0):非冲突路径下,合并时刻(MERGE_HEAD)之后分支若又前进,定版内容不含新提交且工作树将被删——提交即丢失
    if (!mergeState) {
        const mergeHead = (await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "")).trim();
        const tip = (await git(repo, ["rev-parse", "-q", "--verify", `${t.branch}^{commit}`]).catch(() => "")).trim();
        if (mergeHead && tip && mergeHead !== tip) {
            await git(repo, ["merge", "--abort"]).catch(() => { });
            throw new Error(`分支 ${t.name} 在本次合并开始后又产生了新提交:定版内容将是合并时刻的旧头。` +
                `已中止本次合并(main/ 干净回退),请重新调用 vcs_branch_merge 以最新分支头合并`);
        }
    }
    // 顺序:V 文档 → 暂存 → 全量 commit → tag → 注册表登记(提交成功才登记,失败 abort 回退)
    await addPaths(repo, ["."]);
    let sha = "";
    try {
        sha = await commit(repo, `vcs: ${code} — 合并分支 ${t.name}: ${changes}`);
        if (await tagExists(repo, code))
            throw new Error(`tag ${code} 已存在`);
        await createTag(repo, code, `${t.requirement}\n\n${changes}`);
    }
    catch (err) {
        if (reg.mergeInProgress?.name === t.name || (await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => ""))) {
            await git(repo, ["merge", "--abort"]).catch(() => { });
        }
        throw err;
    }
    // 清理顺序(V1.28.0):先删工作树/ref(可能因文件占用失败,须可见),全部成功后才摘注册表——
    // 旧序先摘注册表会让失败后的分支名永久卡死(begin 建议 discard,discard 却查无此分支)
    const wtPath = path.join(repo, t.worktree);
    let wtRemoved = true;
    try {
        await fs.rm(wtPath, { recursive: true, force: true });
    }
    catch {
        wtRemoved = false;
    }
    await git(repo, ["worktree", "prune"]).catch(() => { });
    let refRemoved = true;
    try {
        await git(repo, ["branch", "-D", t.branch]);
    }
    catch {
        refRemoved = false;
    }
    reg.versions.push(entry);
    reg.mergeInProgress = null;
    if (wtRemoved && refRemoved) {
        reg.branches = (reg.branches ?? []).filter((b) => b.name !== t.name);
    }
    else {
        // 清理不完整:保留注册表条目,让 vcs_branch_discard 仍可见、可重试清理,分支名不再死锁
        await wsAppendAudit(repo, tg, "ws_branch_merge", `mode=cleanup-pending name=${t.name} wtRemoved=${wtRemoved} refRemoved=${refRemoved}`);
    }
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, tg, "ws_branch_merge", `mode=done name=${t.name} as=${code} sha=${sha.slice(0, 10)} via=${acc?.via ?? "token"}`);
    return [
        `分支 ${t.name} 已合并定版:${code}(commit ${sha.slice(0, 10)} + tag ${code})`,
        ...(wtRemoved && refRemoved
            ? [`工作树 ${t.worktree} 与分支 ${t.branch} 已清理;版本记录含 mergedFrom 标注`]
            : [`注意:工作树/ref 清理未完成(可能被文件占用),分支条目保留——稍后在分支管理页重试丢弃即可完成清理;版本本身已定版无影响`]),
        ...(acc?.warn ? [acc.warn] : []),
    ].join("\n");
}
export function wsBranchDiscard(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchDiscardUnlocked(repo, opts, tag));
}
/** 导入分支(V1.31.0):把仓库现存未登记的 vcs/task/* 孤儿分支重建工作树并纳入管理 */
export function wsBranchAdopt(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchAdoptUnlocked(repo, opts, tag));
}
async function wsBranchAdoptUnlocked(repo, opts, tag) {
    const t = normTag(tag);
    const source = t.source;
    const client = t.client;
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "导入分支");
    if (!opts.requirement?.trim())
        throw new Error("requirement 必填:记录该分支的用户需求");
    const raw = (opts.name ?? "").trim();
    const name = raw.replace(/^vcs\/task\//, "");
    if (!name || /[\/\\]/.test(name))
        throw new Error(`分支名无效:${raw}(用 vcs_branches 查看 orphan 清单,或给短名)`);
    const branchName = `vcs/task/${name}`;
    reg.branches = reg.branches ?? [];
    if (reg.branches.some((b) => b.name === name)) {
        throw new Error(`分支 ${name} 已在管理中,无需导入`);
    }
    const refExists = (await git(repo, ["branch", "--list", branchName])).trim();
    if (!refExists)
        throw new Error(`分支 ${branchName} 不存在:只有仓库现存且未登记的 vcs/task/* 分支可导入`);
    const worktreeRel = `${WS_BRANCH_DIR}/${name}`;
    const worktreeAbs = path.join(repo, worktreeRel);
    await git(repo, ["worktree", "prune"]);
    await fs.rm(worktreeAbs, { recursive: true, force: true }).catch(() => { });
    await git(repo, ["worktree", "prune"]);
    await fs.mkdir(path.dirname(worktreeAbs), { recursive: true });
    await ensureGitExclude(repo);
    await git(repo, ["worktree", "add", worktreeAbs, branchName]);
    // 基点:取该分支与主干的分叉 commit(回滚交叉检测用);取不到则记当前 HEAD
    let baseline = "";
    try {
        baseline = (await git(repo, ["merge-base", "HEAD", branchName])).trim();
    }
    catch {
        /* ignore */
    }
    if (!baseline)
        baseline = await head(repo);
    const token = newSessionToken();
    const assignedClient = normAssignee(opts.assignee);
    reg.branches.push({
        name,
        branch: branchName,
        worktree: worktreeRel,
        requirement: opts.requirement.trim(),
        token,
        ownerSource: source,
        ownerClient: client,
        ...(assignedClient ? { assignedClient } : {}),
        baseline,
        startedAt: nowStr(),
        lastActiveAt: nowStr(),
    });
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, t, "ws_branch_adopt", `name=${name} branch=${branchName} baseline=${baseline.slice(0, 10)}`);
    return {
        token,
        branch: branchName,
        worktree: worktreeRel,
        message: [
            `已导入分支 ${branchName}:工作树 ${worktreeRel} 已重建,纳入统一管理`,
            `用户需求:${opts.requirement.trim()}`,
            `会话令牌:${token} —— 后续 vcs_branch_commit / vcs_branch_merge 经 token 传入(指派工具与 GUI 免令牌)`,
        ].join("\n"),
    };
}
/** 分支内回退(V1.29.0):把分支工作树回退到某个检查点(或回退上一检查点);未提交修改须 force 放弃 */
export function wsBranchRollback(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchRollbackUnlocked(repo, opts, tag));
}
async function wsBranchRollbackUnlocked(repo, opts, tag) {
    const tg = normTag(tag);
    const reg = await wsRequire(repo);
    const b = findBranch(reg, opts.name);
    const acc = requireBranchAccess(b, opts, tag);
    if (reg.mergeInProgress?.name === b.name) {
        throw new Error(`分支 ${b.name} 的合并冲突正在挂起处理,期间分支冻结;先完成或放弃合并`);
    }
    const wt = path.join(repo, b.worktree);
    // 目标解析:缺省=上一检查点(HEAD~1);to 支持完整/短 sha 或 1 基序号
    const checkpoints = (await git(wt, ["log", "--format=%H", "-n", "100", "HEAD"]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    let target = "";
    if (!opts.to?.trim()) {
        if (checkpoints.length < 2)
            throw new Error(`分支 ${b.name} 没有可回退的上一检查点`);
        target = checkpoints[1];
    }
    else {
        const to = opts.to.trim();
        if (/^\d+$/.test(to)) {
            const idx = parseInt(to, 10) - 1; // 序号 1 基:1=最新检查点
            if (idx < 0 || idx >= checkpoints.length) {
                throw new Error(`检查点序号超出范围(1-${checkpoints.length}):${to}`);
            }
            target = checkpoints[idx];
        }
        else {
            target = checkpoints.find((s) => s.startsWith(to)) ?? "";
            if (!target)
                throw new Error(`检查点 ${to} 不在分支 ${b.name} 的最近 ${checkpoints.length} 个提交内`);
        }
    }
    const wtDirty = await statusPorcelain(wt, ["."]);
    if (wtDirty.length > 0 && !opts.force) {
        throw new Error(`分支 ${b.name} 的工作树有 ${wtDirty.length} 处未提交修改,回退会丢弃它们;确认请带 force:true`);
    }
    const subject = (await git(wt, ["log", "-1", "--format=%s", target])).trim();
    await git(wt, ["reset", "--hard", target]);
    b.lastActiveAt = nowStr();
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, tg, "ws_branch_rollback", `name=${b.name} to=${target.slice(0, 10)} via=${acc.via}${wtDirty.length > 0 ? ` discarded_dirty=${wtDirty.length}` : ""}`);
    return [
        `分支 ${b.name} 已回退到检查点 ${target.slice(0, 10)}(${subject})`,
        `工作树已回到该检查点内容;其后的检查点提交仍在分支历史中(可用 vcs_branches 查 sha 找回)`,
        ...(acc.warn ? [acc.warn] : []),
    ].join("\n");
}
/** 主干合入分支(V1.29.0):把 main/ 最新内容合入分支工作树,长命分支对齐主干;也用于回滚后让分支适配新主干 */
export function wsBranchUpdate(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchUpdateUnlocked(repo, opts, tag));
}
async function wsBranchUpdateUnlocked(repo, opts, tag) {
    const tg = normTag(tag);
    const reg = await wsRequire(repo);
    const b = findBranch(reg, opts.name);
    const acc = requireBranchAccess(b, opts, tag);
    if (reg.mergeInProgress) {
        throw new Error(`分支 ${reg.mergeInProgress.name} 的合并冲突尚未处理完(单槽):先完成或放弃它`);
    }
    const wt = path.join(repo, b.worktree);
    const wtDirty = await statusPorcelain(wt, ["."]);
    if (wtDirty.length > 0) {
        throw new Error(`分支 ${b.name} 的工作树有 ${wtDirty.length} 处未提交修改:先 vcs_branch_commit 存检查点再更新`);
    }
    const mainHead = await head(repo);
    let mergeOk = false;
    try {
        await git(wt, ["merge", "--no-ff", "--no-commit", mainHead]);
        mergeOk = true;
    }
    catch {
        mergeOk = false;
    }
    if (mergeOk) {
        // 无冲突:直接提交合入
        await addPaths(wt, ["."]);
        await commit(wt, `vcs-branch: ${b.name} — 合入主干 main/ 最新内容(${mainHead.slice(0, 10)})`);
    }
    else {
        // 有冲突:保留冲突现场(工作树内),由 AI/用户在分支工作树解决后存检查点(merge --continue 语义)
        const conflicts = (await git(wt, ["diff", "--name-only", "--diff-filter=U"])).trim();
        await wsAppendAudit(repo, tg, "ws_branch_update", `name=${b.name} conflicts=${conflicts ? conflicts.split("\n").length : "?"} via=${acc.via}`);
        return [
            `主干合入分支 ${b.name} 产生冲突(${conflicts ? conflicts.split("\n").length : "?"} 处),已保留冲突现场:`,
            ...conflicts.split("\n").slice(0, 10).map((c) => `  ${c}`),
            `处理:在工作树内解决冲突标记后 vcs_branch_commit 存检查点(合入即完成);或 git merge --abort 放弃本次更新`,
            ...(acc.warn ? [acc.warn] : []),
        ].join("\n");
    }
    b.lastActiveAt = nowStr();
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, tg, "ws_branch_update", `name=${b.name} from_main=${mainHead.slice(0, 10)} via=${acc.via}`);
    return [
        `主干 main/ 最新内容已合入分支 ${b.name}(工作树与分支 ref 同步更新)`,
        `分支与主干的分叉已对齐;此后 vcs_branch_merge 合并不会再把回滚前的旧变更带回主线`,
        ...(acc.warn ? [acc.warn] : []),
    ].join("\n");
}
async function wsBranchDiscardUnlocked(repo, opts, tag) {
    const tg = normTag(tag);
    const reg = await wsRequire(repo);
    const t = findBranch(reg, opts.name);
    const acc = requireBranchAccess(t, opts, tag);
    // 若该分支正处于合并冲突期,先干净回退合并
    if (reg.mergeInProgress?.name === t.name) {
        await git(repo, ["merge", "--abort"]);
        reg.mergeInProgress = null;
    }
    // 未提交保护(V1.28.0):丢弃即 rm 工作树,未提交修改会直接蒸发——默认拒绝,force 才放行
    const wt = path.join(repo, t.worktree);
    const wtDirty = await statusPorcelain(wt, ["."]);
    if (wtDirty.length > 0 && !opts.force) {
        throw new Error(`分支 ${t.name} 的工作树有 ${wtDirty.length} 处未提交修改,丢弃将直接销毁它们。` +
            `先在分支工作树内 vcs_branch_commit 存检查点;确认放弃这些修改请带 force:true 重试`);
    }
    await fs.rm(wt, { recursive: true, force: true }).catch(() => { });
    await git(repo, ["worktree", "prune"]);
    await git(repo, ["branch", "-D", t.branch]);
    reg.branches = (reg.branches ?? []).filter((b) => b.name !== t.name);
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, tg, "ws_branch_discard", `name=${t.name} branch=${t.branch} via=${acc.via}${wtDirty.length > 0 ? ` discarded_dirty=${wtDirty.length}` : ""}`);
    return `已丢弃并行分支 ${t.name}(工作树与分支 ref 已删除;其上的未合并修改不可恢复,审计已留痕)`;
}
/** 改派/清空分支的管理工具(assignedClient);属主闸与 commit/merge/discard 一致 */
export function wsBranchAssign(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsBranchAssignUnlocked(repo, opts, tag));
}
async function wsBranchAssignUnlocked(repo, opts, tag) {
    const tg = normTag(tag);
    const reg = await wsRequire(repo);
    const b = findBranch(reg, opts.name);
    const acc = requireBranchAccess(b, opts, tag);
    const assigned = normAssignee(opts.assignee);
    const prev = b.assignedClient;
    b.assignedClient = assigned;
    b.lastActiveAt = nowStr();
    await wsSaveRegistry(repo, reg);
    await wsAppendAudit(repo, tg, "ws_branch_assign", `name=${b.name} assignee=${assigned ?? "clear"}${prev ? `(原 ${prev})` : ""} via=${acc.via}`);
    return [
        assigned
            ? `分支 ${b.name} 已改派给「${assigned}」:该工具无需令牌即可在本分支 commit/merge/discard;其他非属主工具默认放行+提醒,strict 档拒绝`
            : `已清除分支 ${b.name} 的指派(管理权回到令牌持有者与 GUI)`,
        ...(acc.warn ? [acc.warn] : []),
    ].join("\n");
}
// ---------------------------------------------------------------- temp 补救
export function wsTempSave(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsTempSaveUnlocked(repo, opts, tag));
}
async function wsTempSaveUnlocked(repo, opts, tag) {
    const t = normTag(tag);
    const source = t.source;
    const client = t.client;
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "保存 temp");
    if (!opts.summary?.trim())
        throw new Error("summary 必填:为什么无法提交、这些变化是什么");
    // 有进行中版本时,main/ 变化属于持有者:仅持有者本人可放弃并转存 temp
    if (reg.inProgress) {
        const ip = reg.inProgress;
        if (!ip.owner || opts.sessionToken !== ip.owner) {
            throw new Error(`${ipOwnerLine(ip)}。main/ 的当前变化归持有者负责,他人不得转存 temp;` +
                `持有者可正常 vcs_commit,或携带自己的令牌调用 vcs_temp_save 放弃任务(将同时清除进行中状态)`);
        }
    }
    // -uall 让未跟踪文件逐个列出(porcelain 默认折叠目录)
    const out = await git(repo, ["status", "--porcelain", "-z", "-uall", "--", WS_MAIN]);
    const entries = parsePorcelainZ(out);
    if (entries.length === 0)
        throw new Error("main/ 无未提交修改,无需保存 temp");
    const base = slugify(opts.name ?? opts.summary, "temp");
    reg.temp = reg.temp ?? [];
    let name = base;
    for (let i = 2; reg.temp.some((t) => t.name === name); i++)
        name = `${base}-${i}`;
    const tempDir = path.join(repo, WS_TEMP_DIR, name);
    await fs.mkdir(tempDir, { recursive: true });
    const copied = [];
    const deleted = [];
    for (const e of entries) {
        const rel = e.path.startsWith(WS_MAIN + "/") ? e.path.slice(WS_MAIN.length + 1) : e.path;
        if (e.xy.includes("D")) {
            deleted.push(rel);
            continue;
        }
        const src = path.join(repo, WS_MAIN, rel);
        const dest = path.join(tempDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest).catch(() => { });
        copied.push(rel);
    }
    const baseline = await head(repo);
    const manifest = { name, summary: opts.summary.trim(), createdAt: nowStr(), baseline, copied, deleted, source, client };
    await fs.writeFile(path.join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await fs.writeFile(path.join(tempDir, "说明.md"), [
        `# temp 补救 — ${name}`,
        "",
        `- 时间:${nowStr()}`,
        `- 原因:${opts.summary.trim()}`,
        `- 基线:${baseline.slice(0, 10)}`,
        `- 保全文件:${copied.length} 个;记录删除:${deleted.length} 个(明细见 manifest.json)`,
        "",
        `处理:GUI「分支」页恢复应用/丢弃,或 vcs_temp_apply{name:"${name}"} / vcs_temp_discard{name:"${name}"}。`,
        "",
    ].join("\n"), "utf8");
    reg.temp.push({
        name,
        summary: opts.summary.trim(),
        createdAt: nowStr(),
        baseline,
        files: copied.length + deleted.length,
        source,
        client,
    });
    await wsSaveRegistry(repo, reg);
    // 恢复 main/ 到 HEAD 干净态:reset 清 staged、checkout 还原改动/删除;
    // 复制走的未跟踪/新暂存文件(HEAD 中不存在)删除
    await git(repo, ["reset", "-q", "HEAD", "--", WS_MAIN]).catch(() => { });
    await git(repo, ["checkout", "--", WS_MAIN]).catch(async () => {
        await git(repo, ["checkout", "HEAD", "--", WS_MAIN]);
    });
    for (const rel of copied) {
        const abs = path.join(repo, WS_MAIN, rel);
        try {
            await fs.access(abs);
            const inHead = (await git(repo, ["ls-tree", "HEAD", "--", `${WS_MAIN}/${rel}`])).trim();
            if (!inHead)
                await fs.rm(abs, { force: true });
        }
        catch {
            /* 文件本就不存在 */
        }
    }
    // 持有者放弃任务:同时清除进行中状态
    if (reg.inProgress) {
        await wsAppendAudit(repo, t, "ws_temp_save", `cleared_inProgress=${reg.inProgress.code}`);
        reg.inProgress = null;
        await wsSaveRegistry(repo, reg);
    }
    await wsAppendAudit(repo, t, "ws_temp_save", `name=${name} copied=${copied.length} deleted=${deleted.length} reason="${opts.summary.trim().slice(0, 100)}"`);
    return [
        `已保存 ${copied.length} 个文件的变更(另有 ${deleted.length} 处删除记录)到 temp/${name}/,main/ 已恢复干净`,
        `原因记录:${opts.summary.trim()}`,
        `处理:确认后 vcs_temp_apply {name:"${name}"} 写回 main/,或 vcs_temp_discard {name:"${name}"} 丢弃;GUI「分支」页同样可操作`,
    ].join("\n");
}
export function wsTempApply(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsTempApplyUnlocked(repo, opts, tag));
}
async function wsTempApplyUnlocked(repo, opts, tag) {
    const reg = await wsRequire(repo);
    assertNoMerge(reg, "应用 temp");
    const item = (reg.temp ?? []).find((t) => t.name === opts.name);
    if (!item)
        throw new Error(`temp 条目不存在:${opts.name}(用 vcs_branches 查看待处理清单)`);
    const tempDir = path.join(repo, WS_TEMP_DIR, item.name);
    let manifest;
    try {
        manifest = JSON.parse(await fs.readFile(path.join(tempDir, "manifest.json"), "utf8"));
    }
    catch {
        throw new Error(`temp/${item.name}/manifest.json 缺失或损坏,无法应用;可手动取回文件后 vcs_temp_discard 清理条目`);
    }
    if (reg.inProgress) {
        throw new Error(`主工作区有进行中的版本(${reg.inProgress.code}):temp 恢复会与它叠加,先由持有者收尾,或确认后用 vcs_begin takeover 处理`);
    }
    for (const rel of manifest.copied ?? []) {
        const dest = path.join(repo, WS_MAIN, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(tempDir, rel), dest);
    }
    for (const rel of manifest.deleted ?? []) {
        await fs.rm(path.join(repo, WS_MAIN, rel), { force: true });
    }
    reg.temp = (reg.temp ?? []).filter((t) => t.name !== item.name);
    await wsSaveRegistry(repo, reg);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    await wsAppendAudit(repo, tag, "ws_temp_apply", `name=${item.name} copied=${manifest.copied?.length ?? 0} deleted=${manifest.deleted?.length ?? 0}`);
    return [
        `temp/${item.name} 已应用回 main/:${manifest.copied?.length ?? 0} 个文件写入、${manifest.deleted?.length ?? 0} 处删除还原`,
        `变更尚未登记:走 vcs_begin → vcs_commit 正式定版,或再次 vcs_temp_save 保存`,
    ].join("\n");
}
export function wsTempDiscard(repo, opts, tag = "api") {
    return withWorkspace(repo, tag, () => wsTempDiscardUnlocked(repo, opts, tag));
}
async function wsTempDiscardUnlocked(repo, opts, tag) {
    const reg = await wsRequire(repo);
    const item = (reg.temp ?? []).find((t) => t.name === opts.name);
    if (!item)
        throw new Error(`temp 条目不存在:${opts.name}`);
    reg.temp = (reg.temp ?? []).filter((t) => t.name !== item.name);
    await wsSaveRegistry(repo, reg);
    await fs.rm(path.join(repo, WS_TEMP_DIR, item.name), { recursive: true, force: true }).catch(() => { });
    await wsAppendAudit(repo, tag, "ws_temp_discard", `name=${item.name}`);
    return `已丢弃 temp/${item.name}(其保存的未提交变化不可恢复,审计已留痕)`;
}
/** GUI 与 vcs_branches 共用:并行分支 + temp + 合并冲突状态的结构化清单 */
export async function wsParallelView(repo) {
    const reg = await wsLoadRegistry(repo);
    if (!reg)
        throw new Error(`${repo} 不是工作区:先 vcs_init`);
    const branches = [];
    let cacheDirty = false;
    for (const t of reg.branches ?? []) {
        let commits = 0;
        let checkpoints = [];
        try {
            commits = parseInt((await git(repo, ["rev-list", "--count", `HEAD..${t.branch}`])).trim(), 10) || 0;
        }
        catch {
            /* 分支 ref 缺失 */
        }
        // 增量优化(V1.30.0):提交数与上次视图一致(检查点未变)时复用注册表缓存,跳过 git log 全量拉取——
        // GUI 双路 15s 轮询下每分支每轮省一个子进程;缓存由 branch-commit/rollback/merge 时刷新
        const seen = t.seenCommits ?? -1;
        const cached = t.checkpointCache;
        if (seen === commits && cached) {
            checkpoints = cached;
        }
        else {
            // 检查点清单:%x00 分隔防 subject 内含 | 等字符被误切;git log 新→旧,反转为旧→新
            try {
                const raw = await git(repo, [
                    "log",
                    "--pretty=%H%x00%s%x00%ad",
                    "--date=format-local:%Y-%m-%d %H:%M",
                    `HEAD..${t.branch}`,
                ]);
                checkpoints = raw
                    .split("\n")
                    .filter((l) => l.trim())
                    .map((l) => {
                    const [sha = "", subject = "", date = ""] = l.split("\x00");
                    return { sha, subject, date };
                })
                    .reverse();
                t.seenCommits = commits;
                t.checkpointCache = checkpoints;
                cacheDirty = true;
            }
            catch {
                /* 分支 ref 缺失,视为无检查点 */
            }
        }
        // 分叉点版本:merge-base 后向前找最近的可达 V tag(一次 describe,供时间线 B{Y}.{Z} 编号)
        let baseVersion;
        try {
            const mb = (await git(repo, ["merge-base", "HEAD", t.branch])).trim();
            if (mb) {
                const d = (await git(repo, ["describe", "--abbrev=0", "--match=V*", mb])).trim();
                if (/^V\d+\.\d+\.\d+$/.test(d))
                    baseVersion = d;
            }
        }
        catch {
            /* 无法定位分叉版本(如无任何 V tag) */
        }
        const stallMinutes = stallMinutesOf(t);
        const dirty = (await statusPorcelain(path.join(repo, t.worktree), ["."])).length;
        branches.push({ ...t, commits, checkpoints, baseVersion, worktreeAbs: path.join(repo, t.worktree), dirty, stalled: stallMinutes >= STALL_MINUTES, stallMinutes });
    }
    let mergeInProgress = null;
    if (reg.mergeInProgress) {
        let conflicts = [];
        try {
            conflicts = (await git(repo, ["diff", "--name-only", "--diff-filter=U"])).trim().split("\n").filter(Boolean);
        }
        catch {
            /* 非 git 冲突状态 */
        }
        mergeInProgress = { ...reg.mergeInProgress, conflicts };
    }
    if (cacheDirty)
        await wsSaveRegistry(repo, reg); // 检查点缓存落库(原子写,随下次定版收编)
    // 孤儿分支(V1.31.0):现存 vcs/task/* ref 减去已登记——供「导入分支」
    // git branch --list 对「被其他 worktree 检出的分支」标 +、当前分支标 *,一并剥掉
    const refList = (await git(repo, ["branch", "--list", "vcs/task/*"]))
        .split("\n")
        .map((l) => l.trim().replace(/^[*+]\s*/, ""))
        .filter(Boolean)
        .map((l) => l.replace(/^vcs\/task\//, ""));
    const managed = new Set((reg.branches ?? []).map((b) => b.name));
    const orphans = refList.filter((n) => !managed.has(n));
    return { branches, temps: reg.temp ?? [], mergeInProgress, orphans };
}
/** GUI 专用:publish/* 分支只读清单(顶栏切换器「发布」节)。发布分支不登记、不打 V 号、不可切换上下文 */
export async function wsPublishBranches(repo) {
    const refs = (await git(repo, ["branch", "--list", "publish/*"]))
        .split("\n")
        .map((l) => l.trim().replace(/^[*+]\s*/, ""))
        .filter(Boolean);
    refs.sort();
    const out = [];
    for (const branch of refs) {
        const name = branch.replace(/^publish\//, "");
        const version = /^v\d/.test(name) ? `V${name.slice(1)}` : name;
        let sha = "";
        let subject = "";
        let date = "";
        try {
            const raw = await git(repo, [
                "log",
                "-1",
                "--pretty=%H%x00%s%x00%ad",
                "--date=format-local:%Y-%m-%d %H:%M",
                branch,
            ]);
            const [shaRaw = "", subjectRaw = "", dateRaw = ""] = raw.split("\x00");
            sha = shaRaw.trim();
            subject = subjectRaw.trim();
            date = dateRaw.trim(); // 末字段带 git 输出的尾部换行
        }
        catch {
            /* 引用缺失(极罕见),仍返回名字 */
        }
        let files = [];
        try {
            files = (await git(repo, ["ls-tree", "--format=%(objecttype)%x00%(path)", branch]))
                .split("\n")
                .map((l) => l.split("\x00"))
                .filter((p) => p[1]?.trim())
                .map((p) => (p[0] === "tree" ? `${p[1].trim()}/` : p[1].trim()));
        }
        catch {
            /* 同上 */
        }
        out.push({ name, branch, version, sha, date, subject, files });
    }
    return out;
}
// ---------------------------------------------------------------- status / list
export async function wsStatus(repo) {
    const reg = await wsLoadRegistry(repo);
    if (!reg) {
        return `${repo} 不是工作区:先 vcs_init(将创建 main/ + 工作区日志.md + .vcs/)`;
    }
    const dirty = await statusPorcelain(repo, ["."]);
    // 主干口径(V1.27.0):状态徽章只关心 main/;`.vcs` 簿记(audit/registry)随下次定版收编,单列不计入「正在修改」
    const mainDirty = dirty.filter((e) => e.path === WS_MAIN || e.path.startsWith(WS_MAIN + "/"));
    const offenders = dirty.map((e) => e.path).filter((p) => !isAllowedPath(p));
    // 未登记提交:最新版本 tag 之后存在直接 git 提交且改动了 main/(未走 begin/commit 流程,GUI 不可见);
    // 只看 main/ —— 副本管理等只动 V 文件夹/.vcs 的内部维护提交不算
    let unregistered = 0;
    const latestCode = reg.versions.length ? reg.versions[reg.versions.length - 1].code : null;
    if (latestCode) {
        try {
            unregistered =
                parseInt((await git(repo, ["rev-list", "--count", `${latestCode}..HEAD`, "--", WS_MAIN])).trim(), 10) || 0;
        }
        catch {
            /* 最新 tag 缺失等情况,忽略 */
        }
    }
    const lines = [
        `工作区:${reg.title} | ${repo}`,
        `当前最新:${latestCode ?? "(无)"} | 版本总数:${reg.versions.length}`,
        reg.inProgress ? inProgressLine(reg.inProgress) : "进行中:无",
        ...(reg.mergeInProgress
            ? [
                `合并冲突处理中:分支 ${reg.mergeInProgress.name}(需求:${reg.mergeInProgress.requirement});` +
                    `AI 修复 main/ 冲突后再次 vcs_branch_merge 完成定版,或 abort:true 放弃`,
            ]
            : []),
        ...((reg.branches?.length ?? 0) > 0
            ? [
                `并行分支:${reg.branches.length} 个(${reg.branches.map((b) => b.name).join("、")};` +
                    `vcs_branches 查看明细,合并需主工作区先收尾)`,
            ]
            : []),
        ...((reg.temp?.length ?? 0) > 0
            ? [
                `待处理 temp:${reg.temp.length} 个(${reg.temp.map((t) => t.name).join("、")};` +
                    `vcs_temp_apply 恢复应用或 vcs_temp_discard 丢弃)`,
            ]
            : []),
        `工作区变更:${dirty.length} 处(主干 ${mainDirty.length} 处)${offenders.length ? `(含越界 ${offenders.length} 个!)` : ""}`,
        ...(unregistered > 0
            ? [`未登记提交:${unregistered} 个(${latestCode} 之后存在未经 begin/commit 的直接 git 提交,GUI 不会显示这些更新;请在工作区内补记版本)`]
            : []),
        ...(offenders.length
            ? [`越界文件(三类之外,commit 会被拒):\n${offenders.slice(0, 8).map((p) => `  ${p}`).join("\n")}`]
            : []),
    ];
    return lines.join("\n");
}
/** 进行中版本的停滞判定:30 分钟无持有者活动即提示可接管(措辞避开"越界/未登记提交",防 GUI 徽章误红) */
const STALL_MINUTES = 30;
function stallMinutesOf(ip) {
    const t = Date.parse(ipActiveAt(ip));
    if (Number.isNaN(t))
        return 0;
    return Math.max(0, Math.round((Date.now() - t) / 60_000));
}
function inProgressLine(ip) {
    const stall = stallMinutesOf(ip);
    const hint = stall >= STALL_MINUTES
        ? `(已 ${stall} 分钟无活动,疑似停滞;确认对方停止后可 vcs_begin takeover 接管)`
        : "";
    const who = ip.ownerClient ? `${ip.ownerSource ?? "未知"} · 工具 ${ip.ownerClient}` : (ip.ownerSource ?? "未知");
    return (`进行中:${ip.code}(占位)| 需求:${ip.requirement} | 基线:${ip.baseline.slice(0, 10)}` +
        ` | 来源:${who} | 最近活跃:${ipActiveAt(ip)}${hint}`);
}
/** 心跳:持有者携带令牌调用(如 vcs_status),刷新最近活跃时间;须持锁写,避免与 begin/commit 竞态 */
export async function wsTouch(repo, sessionToken, tag = "api") {
    return withWorkspace(repo, tag, async () => {
        const reg = await wsLoadRegistry(repo);
        const ip = reg?.inProgress;
        if (!reg || !ip || !ip.owner || ip.owner !== sessionToken)
            return false;
        ip.lastActiveAt = nowStr();
        await wsSaveRegistry(repo, reg);
        return true;
    });
}
/** GUI 用:进行中版本结构化视图(渲染端不再解析 status 文本) */
export async function wsInProgressView(repo) {
    const reg = await wsLoadRegistry(repo);
    const ip = reg?.inProgress;
    if (!reg || !ip)
        return null;
    const stallMinutes = stallMinutesOf(ip);
    return { ...ip, stalled: stallMinutes >= STALL_MINUTES, stallMinutes };
}
/** 纯函数:从注册表算占用概况(无 IO,GUI 批量刷新项目列表时用) */
export function occupancyOfRegistry(reg) {
    if (!reg)
        return { inProgress: null, branchCount: 0, tempCount: 0, mergeConflict: false };
    const ip = reg.inProgress;
    const stallMinutes = ip ? stallMinutesOf(ip) : 0;
    return {
        inProgress: ip
            ? { ...ip, stalled: stallMinutes >= STALL_MINUTES, stallMinutes }
            : null,
        branchCount: reg.branches?.length ?? 0,
        tempCount: reg.temp?.length ?? 0,
        mergeConflict: !!reg.mergeInProgress,
    };
}
export async function wsListVersions(repo) {
    const reg = await wsRequire(repo);
    const out = [];
    for (const v of reg.versions) {
        const dir = path.join(repo, `V${v.code.slice(1)}`);
        let hasFolder = false;
        let hasCopy = false;
        try {
            await fs.stat(dir);
            hasFolder = true;
            try {
                await fs.stat(path.join(dir, "项目副本"));
                hasCopy = true;
            }
            catch {
                /* 无副本 */
            }
        }
        catch {
            /* 无文件夹 */
        }
        out.push({ ...v, hasFolder, hasCopy });
    }
    return out;
}
export async function wsReadDoc(repo, code, which) {
    if (which === "workspaceLog") {
        try {
            return await fs.readFile(path.join(repo, WS_LOG), "utf8");
        }
        catch {
            return "(无工作区日志)";
        }
    }
    const name = which === "purpose" ? "更新目的.md" : "改动日志.md";
    try {
        return await fs.readFile(path.join(repo, code, name), "utf8");
    }
    catch {
        return `(未找到 ${code}/${name})`;
    }
}
/** 读取工作区某版本(或 "work"=当前 main)中某文件的内容(相对 main/ 的路径) */
export async function wsReadFile(repo, ref, rel) {
    const relNorm = rel.replaceAll("\\", "/");
    if (ref === "work") {
        return fs.readFile(path.join(repo, WS_MAIN, relNorm), "utf8");
    }
    return git(repo, ["show", `${ref}:${WS_MAIN}/${relNorm}`]);
}
/** 列出某版本(或 "work"=当前 main)中全部文件(相对 main/ 的路径) */
export async function wsListFiles(repo, ref) {
    if (ref === "work") {
        const root = path.join(repo, WS_MAIN);
        const files = [];
        async function walk(dir) {
            let items;
            try {
                items = await fs.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const it of items) {
                if (it.name === ".gitkeep")
                    continue;
                const p = path.join(dir, it.name);
                if (it.isDirectory())
                    await walk(p);
                else
                    files.push(path.relative(root, p).replaceAll("\\", "/"));
            }
        }
        await walk(root);
        return files.sort();
    }
    const rawTree = await git(repo, ["ls-tree", "-r", ref, "--", WS_MAIN]);
    return rawTree
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("160000"))
        .map((l) => l.slice(l.indexOf("\t") + 1))
        .map((f) => (f.startsWith(WS_MAIN + "/") ? f.slice(WS_MAIN.length + 1) : f))
        .filter((f) => f !== ".gitkeep")
        .sort();
}
/** main/ 相对某版本的 diff 全文(GUI 对比/详情用) */
export async function wsDiff(repo, from, to, maxLines = 500) {
    return diffFull(repo, from, to, [WS_MAIN], maxLines);
}
export async function wsDiffFiles(repo, from, to) {
    const raw = await git(repo, ["diff", "--name-status", from, to, "--", WS_MAIN]);
    return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
        const tab = l.indexOf("\t");
        const c = tab > 0 ? l.charAt(0) : "M";
        const raw = tab > 0 ? l.slice(tab + 1) : "";
        const file = raw.startsWith(WS_MAIN + "/") ? raw.slice(WS_MAIN.length + 1) : raw;
        return { file, status: (c === "A" || c === "D" ? c : "M") };
    })
        .filter((e) => e.file)
        .sort((a, b) => a.file.localeCompare(b.file));
}
/**
 * 把旧模型论文库(paper_versions/ CN/EN/TEX 编号)迁移为 v3 工作区:
 * 旧库现役管理文件 → 新工作区 main/;旧版本按登记顺序映射为 V0.i.0 存档
 * (每个 V 文件夹带 更新目的.md + 改动日志.md,注明原编号);旧库原样保留。
 */
export function wsMigrateLegacy(newRepo, opts) {
    return withWorkspace(newRepo, opts.source ?? "api", () => wsMigrateLegacyUnlocked(newRepo, opts));
}
async function wsMigrateLegacyUnlocked(newRepo, opts) {
    const oldRaw = await fs
        .readFile(path.join(opts.oldRepo, "paper_versions", "paper-version.json"), "utf8")
        .catch(() => null);
    if (!oldRaw)
        throw new Error(`旧库不存在或无 paper_versions/paper-version.json:${opts.oldRepo}`);
    const old = JSON.parse(oldRaw);
    const includes = [
        ...(old.paths.cn ?? []),
        ...(old.paths.en ?? []),
        ...(old.paths.tex ?? []),
        ...(old.paths.response ?? []),
        ...(old.paths.extra ?? []),
    ];
    // ① 建新工作区目录并把旧库现役文件复制进 main/
    await fs.mkdir(path.join(newRepo, WS_MAIN), { recursive: true });
    const tracked = (await git(opts.oldRepo, ["ls-files", "--", ...includes]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    let copied = 0;
    for (const f of tracked) {
        try {
            const content = await gitBuffer(opts.oldRepo, ["show", `HEAD:${f}`]);
            const dest = path.join(newRepo, WS_MAIN, f);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.writeFile(dest, content);
            copied++;
        }
        catch {
            /* 个别文件读取失败跳过 */
        }
    }
    // ② 初始化新工作区(git init + 结构 + 首提交)——外层已持锁,直接走无锁变体
    const initMsg = await wsInitUnlocked(newRepo, { title: opts.title }, opts.source ?? "api");
    // ③ 旧版本按旧语义轮次映射(创作期→V0.x,一审轮 TEX1.x→V1.x),轮内按登记顺序 .1.0 起
    const reg = (await wsLoadRegistry(newRepo));
    const roundOf = (code) => (/^TEX1\./.test(code) ? 1 : 0);
    const counters = new Map();
    const results = [];
    for (let i = 0; i < old.versions.length; i++) {
        const v = old.versions[i];
        const round = roundOf(v.code);
        const seq = (counters.get(round) ?? 0) + 1;
        counters.set(round, seq);
        const code = `V${round}.${seq}.0`;
        const purpose = v.note || v.summary;
        const changes = `${v.summary}(原编号 ${v.code})`;
        const vDir = path.join(newRepo, code);
        await fs.mkdir(vDir, { recursive: true });
        await fs.writeFile(path.join(vDir, "更新目的.md"), `# 更新目的 —— ${code}\n\n- 日期:${v.date ?? "未记录"}\n- 原编号:${v.code}\n- 更新目的:${purpose}\n`, "utf8");
        let oldLog = "";
        try {
            oldLog = await fs.readFile(path.join(opts.oldRepo, "paper_versions", "changelogs", `${v.code}.md`), "utf8");
        }
        catch {
            /* 旧 changelog 缺失 */
        }
        await fs.writeFile(path.join(vDir, "改动日志.md"), `# 改动日志 —— ${code}(原 ${v.code})\n\n${changes}\n\n${oldLog}`, "utf8");
        reg.versions.push({
            code,
            purpose,
            changes,
            date: v.date ?? nowStr(),
            source: "api",
            origin: v.code,
            originRepo: opts.oldRepo,
            originIncludes: includes,
        });
        results.push(`${code} ← ${v.code} ${v.summary.slice(0, 30)}`);
    }
    await fs.appendFile(path.join(newRepo, WS_LOG), [
        `## ${nowStr()} 旧库迁移`,
        `- 自 ${opts.oldRepo} 迁移 ${old.versions.length} 个历史版本(原编号见各 V 文件夹)与 ${copied} 个现役文件。`,
        `- 旧库原样保留作为存档。`,
        "",
    ].join("\n"), "utf8");
    await wsSaveRegistry(newRepo, reg);
    await addPaths(newRepo, ["."]);
    const paths = await filterExistingPathspecs(newRepo, [
        WS_MAIN,
        WS_LOG,
        WS_DIR,
        ...reg.versions.map((v) => v.code),
    ]);
    await commit(newRepo, `vcs: 自旧论文库迁移(${old.versions.length} 版本,${copied} 文件)`, paths);
    const latest = reg.versions[reg.versions.length - 1];
    await createTag(newRepo, latest.code, `迁移自 ${opts.oldRepo}(原 ${latest.origin})`);
    await wsAppendAudit(newRepo, opts.source ?? "api", "ws_migrate", `from=${opts.oldRepo} versions=${old.versions.length} files=${copied}`);
    return [
        initMsg.split("\n")[0],
        `迁移完成:现役文件 ${copied} 个 → main/;历史 ${old.versions.length} 个 → ${reg.versions[0].code}~${latest.code}`, ...results.slice(0, 6).map((r) => `  ${r}`),
        `  ...(共 ${results.length} 条)`,
        `最新:${latest.code}(原 ${latest.origin});旧库 ${opts.oldRepo} 原样保留`,
    ].join("\n");
}
function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024)
        return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (n >= 1024 * 1024)
        return (n / 1024 / 1024).toFixed(1) + " MB";
    if (n >= 1024)
        return (n / 1024).toFixed(1) + " KB";
    return n + " B";
}
/** 对任意文件夹做"深入分析":结构与体量盘点 + 转为标准工作区的整理方案 */
export async function wsAnalyze(dir) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st || !st.isDirectory())
        throw new Error(`文件夹不存在:${dir}`);
    const reg = await wsLoadRegistry(dir);
    const byType = new Map();
    const topEntries = [];
    let totalFiles = 0;
    let totalBytes = 0;
    const skip = new Set([".git", WS_DIR, "node_modules", "$RECYCLE.BIN", "System Volume Information"]);
    async function walk(d, depth) {
        const items = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const it of items) {
            if (it.name.startsWith(".") && it.name !== ".gitignore")
                continue;
            if (skip.has(it.name))
                continue;
            const p = path.join(d, it.name);
            if (it.isDirectory()) {
                if (depth === 0) {
                    let bytes = 0;
                    const sub = [p];
                    while (sub.length) {
                        const cur = sub.pop();
                        const ents = await fs.readdir(cur, { withFileTypes: true }).catch(() => []);
                        for (const e of ents) {
                            if (e.name.startsWith("."))
                                continue;
                            const cp = path.join(cur, e.name);
                            if (e.isDirectory())
                                sub.push(cp);
                            else
                                bytes += (await fs.stat(cp).catch(() => null))?.size ?? 0;
                        }
                    }
                    topEntries.push({ name: it.name, type: "dir", bytes });
                }
                if (depth < 6)
                    await walk(p, depth + 1);
            }
            else {
                const b = (await fs.stat(p).catch(() => null))?.size ?? 0;
                totalFiles += 1;
                totalBytes += b;
                if (depth === 0)
                    topEntries.push({ name: it.name, type: "file", bytes: b });
                const ext = path.extname(it.name).toLowerCase();
                const cur = byType.get(ext) ?? { count: 0, bytes: 0 };
                cur.count += 1;
                cur.bytes += b;
                byType.set(ext, cur);
            }
        }
    }
    await walk(dir, 0);
    topEntries.sort((a, b) => b.bytes - a.bytes);
    const byTypeArr = [...byType.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 12);
    const plan = reg
        ? [
            "该文件夹已是标准工作区。",
            "建议:vcs_status 检查进行中/越界文件;有未收尾修改则 vcs_commit 收尾。",
        ]
        : [
            `将全部内容(${totalFiles} 个文件,${fmtBytes(totalBytes)})收编进 main/,目录结构原样保留`,
            "初始化 git 与 工作区日志.md / .vcs/",
            "将当前状态列为初始版本 V1.0.0(里程碑)",
            "此后日常改动走 vcs_begin → 修改 main/ → vcs_commit,生成 V X.Y.Z 子文件夹",
        ];
    return {
        dir: path.resolve(dir),
        isWorkspace: !!reg,
        title: reg?.title,
        versionCount: reg?.versions.length ?? 0,
        latest: reg?.versions[reg.versions.length - 1]?.code,
        hasGit: await isRepo(dir),
        totalFiles,
        totalBytes,
        byType: byTypeArr,
        topEntries: topEntries.slice(0, 20),
        plan,
    };
}
