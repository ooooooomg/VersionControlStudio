#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wsAnalyze, wsBeginDetailed, wsBranchAssign, wsBranchAdopt, wsBranchBegin, wsBranchCommit, wsBranchDiscard, wsBranchMerge, wsBranchRollback, wsBranchUpdate, wsCommit, wsDeleteCopy, wsDiff, wsInit, wsListVersions, wsMigrateLegacy, wsParallelView, wsReadDoc, wsRestoreCopy, wsRollback, wsStatus, wsTempApply, wsTempDiscard, wsTempSave, wsTouch, normTag, } from "./workspace.js";
export { resolveRepo } from "./workspace.js";
/** 写工具全集(readonly 档拦截;GUI 传输层不再另设清单,单一事实来源) */
const WRITE_TOOLS = new Set([
    "vcs_init",
    "vcs_begin",
    "vcs_commit",
    "vcs_rollback",
    "vcs_delete_copy",
    "vcs_restore_copy",
    "vcs_migrate",
    "vcs_branch_begin",
    "vcs_branch_commit",
    "vcs_branch_merge",
    "vcs_branch_discard",
    "vcs_branch_assign",
    "vcs_branch_adopt",
    "vcs_branch_rollback",
    "vcs_branch_update",
    "vcs_temp_save",
    "vcs_temp_apply",
    "vcs_temp_discard",
]);
export function isWriteTool(name) {
    return WRITE_TOOLS.has(name);
}
/** 两路径是否同一项目(Windows 大小写不敏感) */
export function sameRepo(a, b) {
    const x = path.resolve(a);
    const y = path.resolve(b);
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/**
 * repoPath 解析链(多工具多项目路由的核心):
 * 显式参数 > 路由表绑定项目(ctx.defaultRepo) > env PAPER_VERSION_REPO;
 * 越界(显式指向绑定项目之外):strict=true 抛错拒绝,false 返回警告文本放行。
 */
export function resolveRepoFor(repoPath, ctx, env = process.env) {
    const explicit = repoPath?.trim();
    const candidate = explicit || ctx.defaultRepo?.trim() || env.PAPER_VERSION_REPO?.trim();
    if (!candidate) {
        throw new Error("缺少 repoPath:请传入当前项目文件夹的绝对路径(多项目环境下必须显式指定;若本工具已在桌面端绑定默认项目,不传即自动路由)");
    }
    const repo = path.resolve(candidate);
    let warn = "";
    if (explicit && ctx.defaultRepo?.trim() && !sameRepo(explicit, ctx.defaultRepo)) {
        const bound = path.resolve(ctx.defaultRepo);
        const who = ctx.client ?? "未命名工具";
        if (ctx.strict) {
            throw new Error(`严格路由:工具「${who}」已指定项目 ${bound},本次调用目标 ${repo} 超出绑定,已拒绝。` +
                `如需操作其他项目:桌面端「设置 → AI 工具连接」调整该工具的绑定或关闭严格拒绝,或改用未绑定的接入路径`);
        }
        warn = `路由提醒:工具「${who}」已指定项目 ${bound},本次操作目标是 ${repo}(越界操作,请核对是否拿错了项目)`;
    }
    return { repo, warn };
}
export function createServer(source = "mcp-stdio", ctx = {}) {
    const server = new McpServer({
        name: "vcs-workspace",
        version: "1.0.0",
    });
    const tag = normTag({ source, client: ctx.client });
    const clientLabel = ctx.client ?? "未命名工具";
    const R = (repoPath) => resolveRepoFor(repoPath, ctx, process.env).repo;
    const repoOpt = {
        repoPath: z
            .string()
            .optional()
            .describe("工作区文件夹(绝对路径);解析顺序:显式参数 > 路由表绑定的默认项目 > PAPER_VERSION_REPO 环境变量"),
    };
    // 统一注册闸:readonly 按调用方拦截全部写工具;非严格越界在结果尾部附加警告行
    // (SDK 的 ToolCallback 为多重泛型联合,边界处用 any 收敛;工具规格与返回结构仍为字面量)
    function reg(name, spec, handler) {
        server.registerTool(name, spec, async (args) => {
            if (ctx.permission === "readonly" && WRITE_TOOLS.has(name)) {
                throw new Error(`工具「${clientLabel}」以只读模式接入(readonly),写操作 ${name} 已拒绝;` +
                    `请在桌面端「设置 → AI 工具连接」调整该工具的权限档,或改用 auto 权限的接入路径`);
            }
            const res = await handler(args);
            if (ctx.defaultRepo && args && typeof args === "object" && "repoPath" in args) {
                try {
                    const { warn } = resolveRepoFor(args.repoPath, ctx, process.env);
                    if (warn && res?.content?.[0]?.type === "text") {
                        res.content[0].text += `\n⚠ ${warn}`;
                    }
                }
                catch {
                    /* 严格拒绝等错误由 handler 内 R() 抛出,这里不重复 */
                }
            }
            return res;
        });
    }
    reg("vcs_status", {
        title: "工作区版本状态",
        description: "会话第一步必须调用。返回工作区(一个项目文件夹,内含 main/ 项目主体、V X.Y.Z/ 版本子文件夹、工作区日志.md)的当前状态:最新版本/进行中版本(含来源与最近活跃)/工作区变更/越界文件。只信本工具实况,禁止凭记忆断言版本。若尚不是工作区,先 vcs_init。",
        inputSchema: {
            ...repoOpt,
            sessionToken: z
                .string()
                .optional()
                .describe("本会话 vcs_begin 返回的会话令牌;匹配则刷新进行中版本的最近活跃时间(心跳)"),
        },
    }, async ({ repoPath, sessionToken }) => {
        const repo = R(repoPath);
        if (sessionToken)
            await wsTouch(repo, sessionToken, tag).catch(() => false);
        return { content: [{ type: "text", text: await wsStatus(repo) }] };
    });
    reg("vcs_init", {
        title: "创建工作区",
        description: "把一个文件夹初始化为受管工作区:自动 git init(若需要)并创建 main/(项目主体,用户与 AI 只在此修改)、工作区日志.md、.vcs/(工具状态)。此后 AI 只允许产生这三类产物,越界文件会被 vcs_commit 拒绝。",
        inputSchema: { ...repoOpt, title: z.string().describe("项目名称") },
    }, async ({ repoPath, title }) => ({
        content: [{ type: "text", text: await wsInit(R(repoPath), { title }, tag) }],
    }));
    reg("vcs_begin", {
        title: "开始新版本(记录用户需求)",
        description: "每次用户提出修改需求时必须先调用:记录用户需求并锁定基线,签发会话令牌(收尾 vcs_commit 时经 sessionToken 传回;令牌丢失可用 takeover:\"continue\" 续作)。之后只在 main/ 内修改;禁止在工作区根目录产生 main/、V*、工作区日志.md、.vcs/ 之外的任何文件。若另一会话已有进行中版本:不要替它收尾或回滚,等待其完成;确认其已停止后用 takeover:\"continue\"(沿用原需求与半成品)或 takeover:\"fresh\"(半成品 stash 快照后按新需求开新版本)显式接管。",
        inputSchema: {
            ...repoOpt,
            requirement: z.string().describe("用户本轮修改需求(原话或忠实转述,必填;takeover:\"fresh\" 时为新需求)"),
            takeover: z
                .enum(["continue", "fresh"])
                .optional()
                .describe("显式接管进行中版本:continue=沿用原需求/基线/半成品,换发令牌;fresh=半成品 stash 快照后按新需求干净开始"),
        },
    }, async ({ repoPath, requirement, takeover }) => {
        const r = await wsBeginDetailed(R(repoPath), { requirement, takeover }, tag);
        return { content: [{ type: "text", text: r.message }] };
    });
    reg("vcs_commit", {
        title: "收尾新版本(生成 V 文件夹)",
        description: "修改完成后必须调用:按级别定版 V X.Y.Z → 生成 V 文件夹(更新目的.md=用户需求 + 改动日志.md=相对上一版改动)→ 追加工作区日志.md → git 提交+tag。bump:content=功能迭代(默认)/polish=微调/major=里程碑。必须携带本会话 vcs_begin 签发的会话令牌(sessionToken);替其他会话收尾会被拒绝。越界文件或空改动会被拒绝。",
        inputSchema: {
            ...repoOpt,
            summary: z.string().describe("AI 本轮改动摘要(必填)"),
            bump: z.enum(["content", "polish", "major"]).optional(),
            sessionToken: z
                .string()
                .optional()
                .describe("本会话 vcs_begin 返回的会话令牌(所有权校验,不匹配拒绝提交)"),
            exclude: z
                .array(z.string())
                .optional()
                .describe("版本外排除:这些工作区相对路径(如 main/a/b.ts)的改动不入本版本,原样保留在工作区;用于隔离与本轮需求无关的半成品"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [
            { type: "text", text: await wsCommit(R(repoPath), { ...rest, source: tag }) },
        ],
    }));
    reg("vcs_rollback", {
        title: "回滚到指定版本",
        description: "把 main/ 回滚到指定 V 版本的内容,并将该版本完整项目副本物化到其 V 文件夹(项目副本/)。回滚本身登记为新版本。历史永不改写。工作区有未收尾修改需 discardDirty:true;存在进行中版本时须 resolveInProgress:\"stash\"(半成品快照进 git stash,不丢失)。",
        inputSchema: {
            ...repoOpt,
            code: z.string().describe("目标版本号,如 V0.3.0"),
            reason: z.string().optional(),
            discardDirty: z.boolean().optional(),
            resolveInProgress: z
                .enum(["stash"])
                .optional()
                .describe("存在进行中版本时必须显式传入:半成品 stash 快照后清除进行中状态,再执行回滚"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [
            { type: "text", text: await wsRollback(R(repoPath), { ...rest, source: tag }) },
        ],
    }));
    reg("vcs_delete_copy", {
        title: "删除版本副本",
        description: "删除回滚时物化在 V<版本>/项目副本/ 的完整项目副本(副本管理)。版本历史、tag 与 main/ 均不受影响:该版本内容仍保存在 git tag 中,随时可用 vcs_restore_copy(或 GUI「恢复副本」)重新物化。用于回滚试验结束后清理占空间的副本。",
        inputSchema: {
            ...repoOpt,
            code: z.string().describe("目标版本号,如 V1.10.0"),
        },
    }, async ({ repoPath, code }) => ({
        content: [{ type: "text", text: await wsDeleteCopy(R(repoPath), code, tag) }],
    }));
    reg("vcs_restore_copy", {
        title: "生成版本副本",
        description: "为任意版本生成完整项目副本到 V<版本>/项目副本/(浏览用快照,内容取自版本历史,不影响 main/ 与 tag)。已有副本时拒绝(先删再建);删除用 vcs_delete_copy。",
        inputSchema: {
            ...repoOpt,
            code: z.string().describe("目标版本号,如 V1.10.0"),
        },
    }, async ({ repoPath, code }) => ({
        content: [{ type: "text", text: await wsRestoreCopy(R(repoPath), code, tag) }],
    }));
    reg("vcs_versions", {
        title: "版本清单",
        description: "列出工作区全部 V 版本(编号/需求/改动/日期/提交方式/副本物化状态)。",
        inputSchema: repoOpt,
    }, async ({ repoPath }) => ({
        content: [
            {
                type: "text",
                text: JSON.stringify(await wsListVersions(R(repoPath)), null, 2),
            },
        ],
    }));
    reg("vcs_read_doc", {
        title: "读取版本文档",
        description: "读取更新目的.md / 改动日志.md / 工作区日志.md 全文。",
        inputSchema: {
            ...repoOpt,
            code: z.string().optional().describe("版本号;which=workspaceLog 时可省略"),
            which: z.enum(["purpose", "changes", "workspaceLog"]),
        },
    }, async ({ repoPath, code, which }) => ({
        content: [
            {
                type: "text",
                text: await wsReadDoc(R(repoPath), code ?? "", which),
            },
        ],
    }));
    reg("vcs_diff", {
        title: "版本间差异",
        description: "对比 main/(项目主体)在两个版本之间的差异。from 必填(V 编号或 git tag);to 缺省=当前 main/ 工作区。mode=stat 统计,full 完整 diff(≤500 行)。",
        inputSchema: {
            ...repoOpt,
            from: z.string().describe("起始版本,如 V0.2.0"),
            to: z.string().optional().describe("目标版本;缺省=当前工作区"),
            mode: z.enum(["stat", "full"]).optional(),
        },
    }, async ({ repoPath, ...rest }) => {
        const text = await wsDiff(R(repoPath), rest.from, rest.to ?? null, rest.mode === "full" ? 500 : 100000);
        return { content: [{ type: "text", text: text || "(无差异)" }] };
    });
    reg("vcs_audit", {
        title: "操作审计流水",
        description: "返回最近 N 条工作区操作审计(时间|来源|操作|结果;来源为 传输通道:工具名,如 mcp-http:claude)。",
        inputSchema: { ...repoOpt, limit: z.number().optional() },
    }, async ({ repoPath, limit }) => {
        const { readFile } = await import("node:fs/promises");
        try {
            const raw = await readFile(path.join(R(repoPath), ".vcs", "audit.log"), "utf8");
            const all = raw.trimEnd().split("\n");
            return {
                content: [{ type: "text", text: all.slice(-(limit ?? 50)).join("\n") || "(暂无)" }],
            };
        }
        catch {
            return { content: [{ type: "text", text: "(暂无审计记录)" }] };
        }
    });
    reg("vcs_migrate", {
        title: "迁移旧论文库",
        description: "把旧模型论文库(paper_versions/,CN/EN/TEX 编号)迁移为 v3 工作区:现役文件→main/,历史→V0.i.0 存档(注明原编号);旧库原样保留。",
        inputSchema: {
            newRepoPath: z.string().describe("新工作区文件夹(将创建)"),
            title: z.string().describe("项目名称"),
            oldRepoPath: z.string().describe("旧库路径(含 paper_versions/)"),
        },
    }, async ({ newRepoPath, title, oldRepoPath }) => ({
        content: [
            {
                type: "text",
                text: await wsMigrateLegacy(path.resolve(newRepoPath), { title, oldRepo: path.resolve(oldRepoPath), source: tag }),
            },
        ],
    }));
    reg("vcs_analyze", {
        title: "深入分析文件夹",
        description: "对任意文件夹做深入分析与整理方案:结构与体量盘点、是否已是工作区、转为标准工作区(main/ + V 版本 + 工作区日志)的整理步骤。用户说『对此工作区进行版本管理』时先调用本工具分析,再按方案执行 vcs_init。",
        inputSchema: {
            dir: z.string().describe("要分析的文件夹(绝对路径)"),
        },
    }, async ({ dir }) => ({
        content: [
            {
                type: "text",
                text: JSON.stringify(await wsAnalyze(path.resolve(dir)), null, 2),
            },
        ],
    }));
    reg("vcs_branches", {
        title: "并行分支与 temp 清单",
        description: "列出工作区的并行分支(名称/需求/指派工具/领先提交数/工作树绝对路径/最近活跃)、待处理 temp 条目与合并冲突状态。用户提及任何分支操作(创建/删除/在分支上变更/合并)前先调本工具看现状;begin 被拒(另一会话占用 main/)或需要处理 temp 时也先调它。",
        inputSchema: repoOpt,
    }, async ({ repoPath }) => ({
        content: [
            { type: "text", text: JSON.stringify(await wsParallelView(R(repoPath)), null, 2) },
        ],
    }));
    reg("vcs_branch_begin", {
        title: "创建并行分支(worktree)",
        description: "创建 git worktree 并行分支 .vcs/branch/<name>/ + 分支 vcs/task/<name>,返回会话令牌,并可用 assignee 指定管理工具(接入名,该工具此后无需令牌即可操作本分支)。当用户说「创建分支」「新建分支」「开个分支并行做 X」时必须使用本工具;**默认从最新版本节点分叉(base 不传),仅当用户明确要求从某个历史版本开分支时才传 base**。无论主工作区是否空闲都会创建真实分支(与主干互不干扰)。之后所有修改都在该工作树目录内进行(不要动 main/),vcs_branch_commit 做检查点(不占 V 版本号),完成后 vcs_branch_merge 合并定版。注意:node_modules 不随检出,构建/测试验证在合并后的主工作区统一做。",
        inputSchema: {
            ...repoOpt,
            requirement: z.string().describe("用户本轮修改需求(原话或忠实转述,必填)"),
            name: z.string().optional().describe("分支短名(缺省自 requirement 生成;.vcs/branch/<name>/)"),
            assignee: z.string().optional().describe("指派的管理工具接入名(如 claude;缺省不指派)"),
            base: z.string().optional().describe("基点版本(V 版本号如 V1.10.0,或 commit sha);缺省当前 HEAD。当用户说「从 V1.10.0 开个分支」时传它"),
        },
    }, async ({ repoPath, requirement, name, assignee, base }) => {
        const r = await wsBranchBegin(R(repoPath), { requirement, name, assignee, base }, tag);
        return { content: [{ type: "text", text: r.message }] };
    });
    reg("vcs_branch_commit", {
        title: "分支检查点提交",
        description: "在并行分支工作树内做检查点提交(普通 git 提交,不占 V 版本号、不生成 V 文件夹)。当用户说「在分支 xx 上变更/提交/存个检查点」时使用。分支属主可调用:令牌持有者、指派工具(assignedClient)、GUI 用户;其他工具默认放行+提醒,strict 档拒绝。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名(vcs_branch_begin 返回)"),
            token: z.string().optional().describe("vcs_branch_begin 签发的会话令牌(被指派工具可省略)"),
            summary: z.string().describe("本检查点做了什么(必填)"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchCommit(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_branch_assign", {
        title: "改派分支管理工具",
        description: "改派或清空并行分支的管理工具(assignedClient)。当用户说「把这个分支交给 XX 工具」「换 XX 管这个分支」时使用;assignee 留空=清除指派。分支属主可调用。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名"),
            assignee: z.string().optional().describe("新指派的工具接入名;留空=清除指派"),
            token: z.string().optional().describe("会话令牌(非 GUI/指派工具调用时携带)"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchAssign(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_branch_rollback", {
        title: "分支回退检查点",
        description: "把并行分支的工作树回退到某个检查点(缺省回退上一检查点;to 支持 1 基序号或 sha 前缀)。当用户说「分支回退/撤销分支上最后一次提交/回到分支的第 N 个检查点」时使用。工作树有未提交修改时默认拒绝(force 确认放弃)。分支属主可调用。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名"),
            to: z.string().optional().describe("目标检查点:1 基序号(1=最新)或 sha 前缀;缺省回退上一检查点"),
            token: z.string().optional().describe("会话令牌(属主可省略)"),
            force: z.boolean().optional().describe("工作树有未提交修改时确认放弃"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchRollback(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_branch_update", {
        title: "主干合入分支",
        description: "把 main/ 最新内容合入并行分支,对齐主干。当用户说「把主干最新合到分支 xx」「分支对齐主干」时使用;分支基点之后主干发生过回滚时,先用它对齐再合并。工作树有未提交修改时拒绝。分支属主可调用。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名"),
            token: z.string().optional().describe("会话令牌(属主可省略)"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchUpdate(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_branch_adopt", {
        title: "导入并行分支",
        description: "把仓库现存但未登记的 vcs/task/* 分支(孤儿分支,如历史清理中断残留)重建工作树并纳入管理。当用户说「导入分支」时使用;先用 vcs_branches 查看 orphans 清单。requirement 必填(记录该分支的用户需求)。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名(不含 vcs/task/ 前缀)"),
            requirement: z.string().describe("该分支的用户需求(必填,原话或忠实转述)"),
            assignee: z.string().optional().describe("指派的管理工具接入名"),
        },
    }, async ({ repoPath, ...rest }) => {
        const r = await wsBranchAdopt(R(repoPath), rest, tag);
        return { content: [{ type: "text", text: r.message }] };
    });
    reg("vcs_branch_merge", {
        title: "合并并行分支(定版)",
        description: "把并行分支合并进 main/ 并生成一个 V 版本(一个需求一个版本)。当用户说「合并分支 xx」「分支收版」时使用。前置:主工作区无进行中版本、无未收尾修改(合并点串行化)。产生冲突时返回冲突文件清单并挂起:在 main/ 内修复冲突标记后再次调用本工具完成定版,或传 abort:true 干净放弃(分支保留)。分支属主可调用(令牌/指派工具/GUI)。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名"),
            token: z.string().optional().describe("vcs_branch_begin 签发的会话令牌(被指派工具/GUI 可省略)"),
            summary: z.string().optional().describe("合并说明(缺省自动生成)"),
            abort: z.boolean().optional().describe("放弃当前挂起的合并,main/ 干净回退,分支保留"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchMerge(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_branch_discard", {
        title: "丢弃并行分支",
        description: "删除并行分支的工作树与分支 ref(未合并的修改不可恢复,写审计)。当用户说「删除/删减分支 xx」「不要这个分支了」时使用——先向用户确认再调。工作树有未提交修改时默认拒绝(force:true 确认放弃);该分支处于合并冲突挂起期会先干净回退合并。分支属主可调用(令牌/指派工具/GUI)。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("分支短名"),
            token: z.string().optional().describe("vcs_branch_begin 签发的会话令牌(被指派工具/GUI 可省略)"),
            force: z.boolean().optional().describe("工作树有未提交修改时确认放弃并丢弃"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsBranchDiscard(R(repoPath), { ...rest, strict: ctx.strict }, tag) }],
    }));
    reg("vcs_temp_save", {
        title: "temp 补救:保全无法提交的变化",
        description: "补救通道:发现项目被锁/越界无法清理/其他原因无法提交时,把 main/ 里已产生的变化复制保全到工作区根目录 temp/<name>/(含 manifest 与说明.md),随后 main/ 恢复干净——变化不丢、工作区解堵。之后由用户决定 vcs_temp_apply 恢复应用或 vcs_temp_discard 丢弃。注意:有进行中版本时仅持有者可调用(会同时放弃该任务);合并冲突处理期间不可用。",
        inputSchema: {
            ...repoOpt,
            summary: z.string().describe("为什么无法提交、这些变化是什么(必填,写入说明.md)"),
            name: z.string().optional().describe("temp 短名(缺省自 summary 生成;temp/<name>/)"),
            sessionToken: z.string().optional().describe("有进行中版本时,持有者的会话令牌"),
        },
    }, async ({ repoPath, ...rest }) => ({
        content: [{ type: "text", text: await wsTempSave(R(repoPath), rest, tag) }],
    }));
    reg("vcs_temp_apply", {
        title: "应用 temp 回 main/",
        description: "把 temp/<name>/ 保存的变化写回 main/(按 manifest 恢复文件与删除)。应用后变更未登记,需走 vcs_begin → vcs_commit 定版。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("temp 短名"),
        },
    }, async ({ repoPath, name }) => ({
        content: [{ type: "text", text: await wsTempApply(R(repoPath), { name }, tag) }],
    }));
    reg("vcs_temp_discard", {
        title: "丢弃 temp",
        description: "删除 temp/<name>/ 与其登记条目(其中保存的未提交变化不可恢复,写审计)。",
        inputSchema: {
            ...repoOpt,
            name: z.string().describe("temp 短名"),
        },
    }, async ({ repoPath, name }) => ({
        content: [{ type: "text", text: await wsTempDiscard(R(repoPath), { name }, tag) }],
    }));
    return server;
}
/** 独立 stdio 入口:身份与路由/权限均可经环境变量注入(PVC_CLIENT / PAPER_VERSION_REPO / PVC_PERMISSION / PVC_STRICT) */
export async function startServer(source = "mcp-stdio") {
    const ctx = {
        client: process.env.PVC_CLIENT?.trim() || undefined,
        permission: (process.env.PVC_PERMISSION ?? "").trim().toLowerCase() === "readonly" ? "readonly" : "auto",
        strict: ["1", "true", "yes"].includes((process.env.PVC_STRICT ?? "").trim().toLowerCase()),
    };
    const server = createServer(source, ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[vcs-workspace] MCP server running on stdio\n");
}
const selfPath = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(selfPath)) {
    startServer().catch((err) => {
        process.stderr.write(`fatal: ${err}\n`);
        process.exit(1);
    });
}
