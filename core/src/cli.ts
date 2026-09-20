#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  wsAnalyze,
  wsBeginDetailed,
  wsBranchAssign,
  wsBranchAdopt,
  wsBranchBegin,
  wsBranchRollback,
  wsBranchUpdate,
  wsBranchCommit,
  wsBranchDiscard,
  wsBranchMerge,
  wsCommit,
  wsDeleteCopy,
  wsDiff,
  wsInit,
  wsListVersions,
  wsMigrateLegacy,
  wsParallelView,
  wsReadDoc,
  wsRestoreCopy,
  wsRollback,
  wsStatus,
  wsTempApply,
  wsTempDiscard,
  wsTempSave,
  resolveRepo,
  type AuditSource,
  type AuditTag,
} from "./workspace.js";

const USAGE = `vcs-workspace — 工作区项目版本控制(MCP server + CLI)

一个项目 = 一个工作区文件夹:
  main/          项目主体(用户与 AI 只在此修改)
  V X.Y.Z/       每版本:更新目的.md + 改动日志.md(回滚时物化项目副本)
  工作区日志.md   用户需求与 AI 改动总账
  .vcs/          工具状态(registry + 审计 + write.lock)

用法:
  vcs serve                          启动 MCP server(stdio)
  vcs init   --dir <工作区> --title <名称>
  vcs begin  --dir <工作区> --requirement <用户需求> [--takeover continue|fresh]
             begin 返回会话令牌;commit 时需 --token 传回。接管他人进行中版本:
             continue=沿用原需求与半成品换发令牌;fresh=半成品 stash 快照后开新需求
  vcs commit --dir <工作区> --summary <改动摘要> [--bump content|polish|major] --token <会话令牌>
             [--exclude 路径 ...]   排除路径的改动不入本版本(原样留在工作区,隔离无关半成品)
  vcs status / versions / log
  vcs read   --dir <工作区> --code V0.1.0 --which purpose|changes|workspaceLog
  vcs diff   --dir <工作区> --from V0.1.0 [--to V0.2.0|main] [--mode full]
  vcs analyze --dir <文件夹>            深入分析并给出整理为标准工作区的方案
  vcs rollback --dir <工作区> --code V0.1.0 [--reason ...] [--discard-dirty]
               [--resolve-in-progress stash]   有进行中版本时必须:半成品 stash 快照后回滚
  vcs delete-copy  --dir <工作区> --code V0.1.0   删除回滚物化的项目副本(历史与 tag 不变,可恢复)
  vcs restore-copy --dir <工作区> --code V0.1.0   重新物化已删除的项目副本(取自版本历史)
  vcs migrate --new <新工作区> --old <旧库> --title <名称>

并行分支(独立工作树上并行开发,与主干互不干扰):
  vcs branch-begin --dir <工作区> --requirement <需求> [--name <短名>] [--assignee <接入名>] [--base <V版本|sha>]
                   创建 .vcs/branch/<name>/ 工作树 + 分支 vcs/task/<name>,返回会话令牌;
                   --assignee 指派管理工具;--base 从历史版本节点长出分支(缺省当前 HEAD);之后在该目录内修改(勿动 main/)
  vcs branch-commit --dir <工作区> --name <短名> [--token <令牌>] --summary <摘要>
                   检查点提交(不占 V 版本号);属主=令牌持有者/指派工具/GUI
  vcs branch-assign --dir <工作区> --name <短名> [--assignee <接入名>]
                   改派/清空(留空清除)分支的管理工具
  vcs branch-adopt --dir <工作区> --name <短名> --requirement <需求> [--assignee <接入名>]
                   导入仓库现存未登记的 vcs/task/* 孤儿分支(重建工作树纳入管理)
  vcs branch-rollback --dir <工作区> --name <短名> [--to <序号|sha>] [--force]
                   分支内回退检查点(缺省回退上一检查点;--force 放弃未提交修改)
  vcs branch-update --dir <工作区> --name <短名>
                   把主干 main/ 最新内容合入分支(对齐主干;回滚后先对齐再合并)
  vcs branch-merge --dir <工作区> --name <短名> [--token <令牌>] [--summary ...] [--abort]
                   合并定版(前置:主工作区已收尾);冲突时返回清单,修复后重调完成,--abort 干净放弃
  vcs branch-discard --dir <工作区> --name <短名> [--token <令牌>] [--force]
                   丢弃分支(工作树有未提交修改时须 --force 确认放弃)
  vcs branches  --dir <工作区>            分支 + temp + 合并冲突状态清单

temp 补救(无法提交时保全 main/ 变化到 temp/<name>/):
  vcs temp-save  --dir <工作区> --summary <原因> [--name <短名>] [--token <持有者令牌>]
  vcs temp-apply --dir <工作区> --name <短名>
  vcs temp-discard --dir <工作区> --name <短名>

版本号 V{X.Y.Z}:X=里程碑,Y=功能迭代,Z=微调。
多会话守则:进行中版本属于签发它的会话;请勿替其他会话收尾或回滚,等待其完成,
或确认其已停止后用 begin --takeover 显式接管(接管会写审计)。
`;

interface Args {
  dir?: string;
  [k: string]: string | boolean | undefined;
}

function parse(): { cmd: string; a: Args; excludes: string[] } {
  const argv = process.argv.slice(2);
  const excludes: string[] = [];
  if (argv.length === 0) return { cmd: "help", a: {}, excludes };
  const cmd = argv[0]!;
  const a: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else {
        a[key] = next;
        if (key === "exclude") excludes.push(next); // --exclude 可重复,逐条累积
        i++;
      }
    }
  }
  return { cmd, a, excludes };
}

const bool = (v: string | boolean | undefined): boolean =>
  v === true || v === "true";

async function main(): Promise<void> {
  const { cmd, a, excludes } = parse();
  // 提交身份:PVC_CLIENT 环境变量(如 zcode)→ 审计与界面「提交方」显示真实工具名
  const src: AuditSource | AuditTag = process.env.PVC_CLIENT?.trim()
    ? { source: "cli", client: process.env.PVC_CLIENT.trim() }
    : "cli";
  if (cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "serve") {
    const { startServer } = await import("./index.js");
    await startServer("mcp-stdio");
    return;
  }
  const dir = a.dir ? path.resolve(a.dir) : resolveRepo(undefined);
  let out: string;
  switch (cmd) {
    case "init":
      out = await wsInit(dir, { title: String(a.title ?? "") }, src);
      break;
    case "begin": {
      const r = await wsBeginDetailed(
        dir,
        {
          requirement: String(a.requirement ?? ""),
          takeover: a.takeover === "continue" || a.takeover === "fresh" ? a.takeover : undefined,
        },
        src,
      );
      out = r.message;
      break;
    }
    case "commit":
      out = await wsCommit(dir, {
        summary: String(a.summary ?? ""),
        bump: a.bump as "content" | "polish" | "major" | undefined,
        sessionToken: a.token ? String(a.token) : undefined,
        exclude: excludes.length > 0 ? excludes : undefined,
        source: src,
      });
      break;    case "status":
      out = await wsStatus(dir);
      break;
    case "versions": {
      const list = await wsListVersions(dir);
      out = list
        .map(
          (v) =>
            `${v.code} [${v.source === "gui" ? "人工提交" : v.source === "api" || v.source.startsWith("mcp") || v.source === "cli" ? "ZCode提交" : v.source}]${v.materialized ? " 已物化副本" : ""} ${v.date}\n  需求:${v.purpose}\n  改动:${v.changes}`,
        )
        .join("\n");
      break;
    }
    case "log":
      out = await wsReadDoc(dir, "", "workspaceLog");
      break;
    case "read":
      out = await wsReadDoc(dir, String(a.code ?? ""), (a.which as "purpose" | "changes") ?? "purpose");
      break;
    case "diff":
      out =
        (await wsDiff(
          dir,
          String(a.from ?? ""),
          a.to ? String(a.to) : null,
          a.mode === "full" ? 500 : 100000,
        )) || "(无差异)";
      break;
    case "analyze": {
      const r = await wsAnalyze(path.resolve(String(a.dir ?? process.cwd())));
      const kb = (n: number) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + "MB" : Math.ceil(n / 1024) + "KB");
      out = [
        `文件夹:${r.dir}`,
        `状态:${r.isWorkspace ? `已是工作区(${r.title},${r.versionCount} 版本,最新 ${r.latest})` : "未纳管"}`,
        `规模:${r.totalFiles} 个文件 / ${kb(r.totalBytes)}${r.hasGit ? " | 已有 git" : ""}`,
        `类型分布:${r.byType.slice(0, 8).map((t) => `${t.type}×${t.count}(${kb(t.bytes)})`).join("、")}`,
        `顶层:${r.topEntries.slice(0, 10).map((t) => `${t.name}(${t.type === "dir" ? "目录" : kb(t.bytes)})`).join("、")}`,
        `整理方案:\n  - ${r.plan.join("\n  - ")}`,
      ].join("\n");
      break;
    }
    case "rollback":
      out = await wsRollback(
        dir,
        {
          code: String(a.code ?? ""),
          reason: a.reason ? String(a.reason) : undefined,
          discardDirty: bool(a["discard-dirty"] ?? a.discardDirty),
          resolveInProgress:
            String(a["resolve-in-progress"] ?? a.resolveInProgress ?? "") === "stash"
              ? "stash"
              : undefined,
          source: src,
        },
      );
      break;
    case "delete-copy":
      out = await wsDeleteCopy(dir, String(a.code ?? ""), src);
      break;
    case "restore-copy":
      out = await wsRestoreCopy(dir, String(a.code ?? ""), src);
      break;
    case "migrate":
      out = await wsMigrateLegacy(
        path.resolve(String(a.new ?? "")),
        { title: String(a.title ?? ""), oldRepo: path.resolve(String(a.old ?? "")), source: src },
      );
      break;
    case "branch-begin": {
      const r = await wsBranchBegin(
        dir,
        {
          requirement: String(a.requirement ?? ""),
          name: a.name ? String(a.name) : undefined,
          assignee: a.assignee ? String(a.assignee) : undefined,
          base: a.base ? String(a.base) : undefined,
        },
        src,
      );
      out = r.message;
      break;
    }
    case "branch-commit":
      out = await wsBranchCommit(
        dir,
        {
          name: String(a.name ?? ""),
          token: a.token ? String(a.token) : undefined,
          summary: String(a.summary ?? ""),
        },
        src,
      );
      break;
    case "branch-assign":
      out = await wsBranchAssign(
        dir,
        {
          name: String(a.name ?? ""),
          assignee: a.assignee ? String(a.assignee) : undefined,
          token: a.token ? String(a.token) : undefined,
        },
        src,
      );
      break;
    case "branch-adopt": {
      const r = await wsBranchAdopt(
        dir,
        {
          name: String(a.name ?? ""),
          requirement: String(a.requirement ?? ""),
          assignee: a.assignee ? String(a.assignee) : undefined,
        },
        src,
      );
      out = r.message;
      break;
    }
    case "branch-rollback":
      out = await wsBranchRollback(
        dir,
        {
          name: String(a.name ?? ""),
          to: a.to ? String(a.to) : undefined,
          token: a.token ? String(a.token) : undefined,
          force: bool(a.force),
        },
        src,
      );
      break;
    case "branch-update":
      out = await wsBranchUpdate(
        dir,
        { name: String(a.name ?? ""), token: a.token ? String(a.token) : undefined },
        src,
      );
      break;
    case "branch-merge":
      out = await wsBranchMerge(
        dir,
        {
          name: String(a.name ?? ""),
          token: a.token ? String(a.token) : undefined,
          summary: a.summary ? String(a.summary) : undefined,
          abort: bool(a.abort),
        },
        src,
      );
      break;
    case "branch-discard":
      out = await wsBranchDiscard(
        dir,
        {
          name: String(a.name ?? ""),
          token: a.token ? String(a.token) : undefined,
          force: bool(a.force),
        },
        src,
      );
      break;
    case "branches":
      out = JSON.stringify(await wsParallelView(dir), null, 2);
      break;
    case "temp-save":
      out = await wsTempSave(
        dir,
        {
          summary: String(a.summary ?? ""),
          name: a.name ? String(a.name) : undefined,
          sessionToken: a.token ? String(a.token) : undefined,
        },
        src,
      );
      break;
    case "temp-apply":
      out = await wsTempApply(dir, { name: String(a.name ?? "") }, src);
      break;
    case "temp-discard":
      out = await wsTempDiscard(dir, { name: String(a.name ?? "") }, src);
      break;
    default:
      process.stdout.write(`未知命令:${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
  }
  process.stdout.write(out + "\n");
}

const selfPath = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(selfPath)) {
  main().catch((err: unknown) => {
    process.stderr.write(`错误:${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
