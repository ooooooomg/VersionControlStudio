import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ws from "versioncontrol-mcp/dist/workspace.js";
import { CH, type ClientRoute, type CustomAiClient, type Envelope, type McpConnectionReport, type ProjectSummary, type Theme, type StudioSettings } from "../shared/types.js";
import { loadSettings, removeRepo, setClientRoute, setCustomClients, setRepo, setService, setTheme, setViewStyle } from "./settings.js";
import { watchRepo } from "./watcher.js";
import { mcpHttpStatus, startMcpHttp, stopMcpHttp } from "./mcp-http.js";
import { classifyClient, readConnections } from "./mcp-connections.js";
import { healthCheck, listClients, loadCustomClients, snippet, writeConfig } from "./ai-clients.js";

function rethrowUnlessExists(e: unknown): void {
  const err = e as NodeJS.ErrnoException;
  if (err?.code !== "EEXIST") throw e;
}

const selfDir = path.dirname(fileURLToPath(import.meta.url));

function wrap<T>(fn: () => Promise<T>): Promise<Envelope<T>> {
  return fn()
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
}

async function applyService(settings: StudioSettings): Promise<void> {
  if (settings.repoPath) process.env.PAPER_VERSION_REPO = settings.repoPath;
  if (settings.mcpEnabled) {
    await startMcpHttp(settings.mcpPort, settings.permissionMode, settings.clientRoutes ?? {}).catch(() => {});
  } else {
    await stopMcpHttp();
  }
}

export async function registerIpc(getWin: () => BrowserWindow | null): Promise<void> {
  let settings = await loadSettings();
  await applyService(settings);
  watchRepo(settings.repoPath, getWin);

  const q = (payload: unknown): Record<string, unknown> =>
    (payload ?? {}) as Record<string, unknown>;
  const repoOf = (payload: unknown): string => {
    const p = q(payload);
    const r = (p.repoPath as string) ?? settings.repoPath;
    if (!r) throw new Error("请先选择工作区文件夹");
    return r;
  };

  ipcMain.handle(CH.settingsGet, () => wrap(async () => settings));

  ipcMain.handle(CH.settingsSetRepo, (_e, payload: unknown) =>
    wrap(async () => {
      settings = await setRepo(String(q(payload).repoPath ?? ""));
      watchRepo(settings.repoPath, getWin);
      await applyService(settings);
      return settings;
    }),
  );

  ipcMain.handle(CH.settingsSetService, (_e, payload: unknown) =>
    wrap(async () => {
      const p = q(payload) as Partial<StudioSettings>;
      settings = await setService({
        mcpEnabled: p.mcpEnabled,
        mcpPort: p.mcpPort,
        permissionMode: p.permissionMode,
      });
      await applyService(settings);
      return settings;
    }),
  );

  ipcMain.handle(CH.settingsSetViewStyle, (_e, payload: unknown) =>
    wrap(async () => {
      settings = await setViewStyle(String(q(payload).viewStyle) as "cards" | "list");
      return settings;
    }),
  );

  ipcMain.handle(CH.settingsRemoveRepo, (_e, payload: unknown) =>
    wrap(async () => {
      settings = await removeRepo(String(q(payload).repoPath ?? ""));
      watchRepo(settings.repoPath, getWin);
      return settings;
    }),
  );

  ipcMain.handle(CH.settingsCustomClients, (_e, payload: unknown) =>
    wrap(async () => {
      settings = await setCustomClients((q(payload).list ?? []) as CustomAiClient[]);
      return settings;
    }),
  );

  // 工具接入路由:GUI 里「指定某工具操作某项目」;保存后重启 HTTP 端点让路由热生效
  ipcMain.handle(CH.settingsSetRoutes, (_e, payload: unknown) =>
    wrap(async () => {
      const p = q(payload) as { key?: string; route?: ClientRoute | null };
      const key = String(p.key ?? "").trim();
      if (!key) throw new Error("接入名必填(即 /mcp/<接入名> 的最后一段)");
      settings = await setClientRoute(key, p.route ?? null);
      await applyService(settings);
      return settings;
    }),
  );

  ipcMain.handle(CH.settingsSetTheme, (_e, payload: unknown) =>
    wrap(async () => {
      settings = await setTheme(String(q(payload).theme) as Theme);
      return settings;
    }),
  );

  ipcMain.handle(CH.projectsList, () =>
    wrap(async (): Promise<ProjectSummary[]> => {
      const out: ProjectSummary[] = [];
      for (const p of settings.recents) {
        const reg = await ws.wsLoadRegistry(p).catch(() => null);
        if (!reg) {
          // 非(尚未是)工作区:仍列出,便于引导初始化/迁移
          out.push({ repoPath: p, isWorkspace: false, title: path.basename(p), latest: null, versionCount: 0 });
          continue;
        }
        const latest = reg.versions[reg.versions.length - 1];
        out.push({
          repoPath: p,
          isWorkspace: true,
          title: reg.title,
          latest: latest?.code ?? null,
          versionCount: reg.versions.length,
          createdAt: reg.createdAt,
          updatedAt: latest?.date ?? reg.createdAt,
          occupancy: ws.occupancyOfRegistry(reg),
        });
      }
      return out;
    }),
  );

  ipcMain.handle(CH.pickRepo, () =>
    wrap(async () => {
      const r = await dialog.showOpenDialog(getWin()!, {
        properties: ["openDirectory"],
        title: "选择工作区文件夹(将成为受管项目)",
      });
      if (r.canceled || r.filePaths.length === 0) return null;
      settings = await setRepo(r.filePaths[0]!);
      watchRepo(settings.repoPath, getWin);
      await applyService(settings);
      return settings;
    }),
  );

  ipcMain.handle(CH.wsStatus, (_e, payload) =>
    wrap(() => ws.wsStatus(repoOf(payload))),
  );
  ipcMain.handle(CH.wsVersions, (_e, payload) =>
    wrap(() => ws.wsListVersions(repoOf(payload))),
  );
  ipcMain.handle(CH.wsReadDoc, (_e, payload) =>
    wrap(() => {
      const p = q(payload);
      return ws.wsReadDoc(repoOf(p), String(p.code ?? ""), p.which as "purpose" | "changes" | "workspaceLog");
    }),
  );
  ipcMain.handle(CH.wsInit, (_e, payload) =>
    wrap(async () => {
      const p = q(payload);
      const r = ws.resolveRepo(String(p.dir ?? repoOf(payload)));
      const msg = await ws.wsInit(r, { title: String(p.title ?? "") }, "gui");
      await wsAppendAuditSafe(r, "ws_init", `title=${p.title}`);
      return msg;
    }),
  );
  ipcMain.handle(CH.wsRollback, (_e, payload) =>
    wrap(async () => {
      const p = q(payload) as {
        code: string;
        reason?: string;
        discardDirty?: boolean;
        resolveInProgress?: "stash";
      };
      return (await ws.wsRollback(repoOf(p), { ...p, source: "gui" })).trim();
    }),
  );
  ipcMain.handle(CH.wsInProgress, (_e, payload) =>
    wrap(() => ws.wsInProgressView(repoOf(payload))),
  );
  ipcMain.handle(CH.wsParallel, (_e, payload) =>
    wrap(() => ws.wsParallelView(repoOf(payload))),
  );
  ipcMain.handle(CH.wsOffenders, (_e, payload) =>
    wrap(() => ws.wsOffenders(repoOf(payload))),
  );
  ipcMain.handle(CH.wsPublish, (_e, payload) =>
    wrap(() => ws.wsPublishBranches(repoOf(payload))),
  );
  ipcMain.handle(CH.wsBranchBegin, (_e, payload) =>
    wrap(() => {
      const p = q(payload) as { requirement?: string; name?: string; assignee?: string; base?: string };
      // GUI 新建分支(source=gui):无论主干是否空闲都创建真实分支;可指定基点版本
      return ws.wsBranchBegin(
        repoOf(p),
        {
          requirement: String(p.requirement ?? ""),
          name: p.name?.trim() || undefined,
          assignee: p.assignee?.trim() || undefined,
          base: p.base?.trim() || undefined,
        },
        "gui",
      );
    }),
  );
  ipcMain.handle(CH.wsBranchAdopt, (_e, payload) =>
    wrap(() => {
      const p = q(payload) as { name?: string; requirement?: string; assignee?: string };
      return ws.wsBranchAdopt(
        repoOf(p),
        {
          name: String(p.name ?? ""),
          requirement: String(p.requirement ?? ""),
          assignee: p.assignee?.trim() || undefined,
        },
        "gui",
      );
    }),
  );
  ipcMain.handle(CH.wsBranchRollback, (_e, payload) =>
    wrap(() => {
      const p = q(payload) as { name?: string; to?: string; force?: boolean };
      return ws.wsBranchRollback(
        repoOf(p),
        { name: String(p.name ?? ""), to: p.to?.trim() || undefined, force: !!p.force },
        "gui",
      );
    }),
  );
  ipcMain.handle(CH.wsBranchUpdate, (_e, payload) =>
    wrap(() => ws.wsBranchUpdate(repoOf(payload), { name: String(q(payload).name ?? "") }, "gui")),
  );
  ipcMain.handle(CH.wsBranchAssign, (_e, payload) =>
    wrap(() => {
      const p = q(payload) as { name?: string; assignee?: string };
      // GUI 改派(source=gui):assignee 空 = 清除指派
      return ws.wsBranchAssign(
        repoOf(p),
        { name: String(p.name ?? ""), assignee: p.assignee?.trim() || undefined },
        "gui",
      );
    }),
  );
  ipcMain.handle(CH.wsBranchMerge, (_e, payload) =>
    wrap(async () => {
      const p = q(payload) as { name: string; summary?: string; abort?: boolean };
      // GUI 发起 = 用户授权(source=gui),无需分支令牌,写审计
      return ws.wsBranchMerge(repoOf(p), { ...p }, "gui");
    }),
  );
  ipcMain.handle(CH.wsBranchDiscard, (_e, payload) =>
    wrap(() =>
      ws.wsBranchDiscard(
        repoOf(payload),
        { name: String(q(payload).name ?? ""), force: !!q(payload).force },
        "gui",
      ),
    ),
  );
  ipcMain.handle(CH.wsTempApply, (_e, payload) =>
    wrap(() => ws.wsTempApply(repoOf(payload), { name: String(q(payload).name ?? "") }, "gui")),
  );
  ipcMain.handle(CH.wsTempDiscard, (_e, payload) =>
    wrap(() => ws.wsTempDiscard(repoOf(payload), { name: String(q(payload).name ?? "") }, "gui")),
  );
  ipcMain.handle(CH.wsTakeover, (_e, payload) =>
    wrap(async () => {
      const p = q(payload) as { mode: "continue" | "fresh"; requirement?: string };
      const mode = p.mode === "fresh" ? "fresh" : "continue";
      const r = await ws.wsBeginDetailed(
        repoOf(p),
        { requirement: String(p.requirement ?? ""), takeover: mode },
        "gui",
      );
      return r.message;
    }),
  );
  ipcMain.handle(CH.wsDeleteCopy, (_e, payload) =>
    wrap(() => ws.wsDeleteCopy(repoOf(payload), String(q(payload).code ?? ""), "gui")),
  );
  ipcMain.handle(CH.wsRestoreCopy, (_e, payload) =>
    wrap(() => ws.wsRestoreCopy(repoOf(payload), String(q(payload).code ?? ""), "gui")),
  );
  ipcMain.handle(CH.wsMigrate, (_e, payload) =>
    wrap(async () => {
      const p = q(payload) as { newDir?: string; oldRepo?: string; title?: string };
      const target = path.resolve(String(p.newDir ?? ""));
      const msg = await ws.wsMigrateLegacy(target, { title: String(p.title ?? ""), oldRepo: path.resolve(String(p.oldRepo ?? "")), source: "gui" });
      settings = await setRepo(target);
      watchRepo(settings.repoPath, getWin);
      await applyService(settings);
      return msg;
    }),
  );

  ipcMain.handle(CH.fileAt, (_e, payload) =>
    wrap(async () => {
      const p = q(payload);
      return ws.wsReadFile(repoOf(p), String(p.ref), String(p.file));
    }),
  );
  ipcMain.handle(CH.versionFiles, (_e, payload) =>
    wrap(() => ws.wsListFiles(repoOf(payload), String(q(payload).ref))),
  );
  ipcMain.handle(CH.diffFiles, (_e, payload) =>
    wrap(() =>
      ws.wsDiffFiles(
        repoOf(payload),
        String(q(payload).from),
        String(q(payload).to),
      ),
    ),
  );

  ipcMain.handle(CH.aiClients, () =>
    wrap(() => listClients(selfDir, settings.repoPath)),
  );
  ipcMain.handle(CH.aiSnippet, (_e, payload) =>
    wrap(() =>
      snippet(
        selfDir,
        settings.repoPath,
        String(q(payload).id),
        String(q(payload).client ?? "").trim() || undefined,
      ),
    ),
  );
  ipcMain.handle(CH.aiWrite, (_e, payload) =>
    wrap(async () => {
      const client = String(q(payload).client ?? "").trim() || undefined;
      const r = await writeConfig(selfDir, settings.repoPath, String(q(payload).id), client);
      if (settings.repoPath) {
        await ws.wsAppendAudit(settings.repoPath, "gui", "ai_client_register", `${String(q(payload).id)} → ${r.file}`);
      }
      return r;
    }),
  );
  ipcMain.handle(CH.aiHealth, () =>
    wrap(async () => {
      const base = await healthCheck(selfDir, settings.repoPath);
      // 漂移检测:路由/env 绑定的项目路径已失效(搬家/删除)时明确告知,避免 AI 静默操作旧路径
      const drift: string[] = [];
      for (const [k, r] of Object.entries(settings.clientRoutes ?? {})) {
        if (!r.repoPath) continue;
        const reg = await ws.wsLoadRegistry(r.repoPath).catch(() => null);
        if (!reg) drift.push(`工具「${k}」绑定的项目路径已失效:${r.repoPath}(不存在或不是工作区)`);
      }
      if (process.env.PAPER_VERSION_REPO) {
        const envReg = await ws.wsLoadRegistry(process.env.PAPER_VERSION_REPO).catch(() => null);
        if (!envReg) drift.push(`默认环境变量 PAPER_VERSION_REPO 指向的路径已失效:${process.env.PAPER_VERSION_REPO}`);
      }
      return { ...base, drift };
    }),
  );

  ipcMain.handle(CH.mcpConnections, () =>
    wrap(async () => {
      const s = mcpHttpStatus();
      const events = await readConnections();
      const customs = await loadCustomClients();
      const matchCustom = (name: string): string | null => {
        const n = name.toLowerCase();
        for (const c of customs) {
          if (c.match && n.includes(c.match.toLowerCase())) return "custom:" + c.id;
        }
        return null;
      };
      const connected: McpConnectionReport["connected"] = {};
      for (const ev of events) {
        const key = matchCustom(ev.client) ?? classifyClient(ev.client);
        const cur = connected[key];
        if (cur) {
          cur.count += 1;
        } else {
          connected[key] = { key, last: ev.time, transport: ev.transport, rawName: ev.client, count: 1 };
        }
      }
      return {
        service: {
          running: !!s,
          port: s?.port ?? settings.mcpPort,
          url: s ? `http://127.0.0.1:${s.port}/mcp` : "",
          mode: settings.permissionMode,
        },
        events: events.slice(0, 8),
        connected,
      } satisfies McpConnectionReport;
    }),
  );

  ipcMain.handle(CH.serviceStatus, () =>
    wrap(async () => {
      const s = mcpHttpStatus();
      return {
        running: !!s,
        port: s?.port ?? settings.mcpPort,
        url: s ? `http://127.0.0.1:${s.port}/mcp` : "",
        mode: settings.permissionMode,
      };
    }),
  );
  ipcMain.handle(CH.openItem, (_e, payload) =>
    wrap(async () => {
      let p = String(q(payload).path ?? "");
      if (!path.isAbsolute(p)) {
        // 相对路径 → 相对当前工作区解析(修复"打开文件夹"失效)
        const base = settings.repoPath;
        if (!base) throw new Error("无工作区,无法解析相对路径");
        p = path.join(base, p);
      }
      shell.showItemInFolder(p);
    }),
  );

  // 应用内检查更新(GitHub Releases;仅打包态可用,autoDownload=false 由 index.ts 统一设定)
  ipcMain.handle(CH.appUpdateCheck, () =>
    wrap(async () => {
      if (!app.isPackaged) return { supported: false };
      try {
        const r = await autoUpdater.checkForUpdates();
        return {
          supported: true,
          current: app.getVersion(),
          available: r?.isUpdateAvailable ?? false,
          version: r?.updateInfo.version ?? null,
        };
      } catch (err) {
        return { supported: true, current: app.getVersion(), available: false, version: null, error: String(err) };
      }
    }),
  );
  // 下载并安装更新(下载完成即退出安装;用户在设置页显式触发)
  ipcMain.handle(CH.appUpdateInstall, () =>
    wrap(async () => {
      if (!app.isPackaged) return { started: false };
      await autoUpdater.downloadUpdate();
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return { started: true };
    }),
  );

  // 新建项目:在指定父目录下创建 <名称> 文件夹 → 初始化工作区 → 初始版本 V1.0.0(无 AI 参与)
  ipcMain.handle(CH.wsCreate, (_e, payload: unknown) =>
    wrap(async () => {
      const p = q(payload) as { parentDir?: string; title?: string };
      const parent = path.resolve(String(p.parentDir ?? ""));
      const title = String(p.title ?? "").trim();
      if (!title) throw new Error("项目名称必填");
      const target = path.join(parent, title);
      try {
        await fs.access(target);
        throw new Error(`目标文件夹已存在:${target}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") rethrowUnlessExists(e);
      }
      await fs.mkdir(target, { recursive: true });
      const msg1 = await ws.wsInit(target, { title }, "gui");
      // begin 签发会话令牌,commit 校验所有权:同流程内部直接传递
      const begun = await ws.wsBeginDetailed(
        target,
        { requirement: `创建项目并列为初始版本 V1.0.0` },
        "gui",
      );
      await ws.wsCommit(
        target,
        { summary: `初始版本:${title}`, bump: "major", source: "gui", sessionToken: begun.token },
      );
      settings = await setRepo(target);
      watchRepo(settings.repoPath, getWin);
      await applyService(settings);
      return `${msg1.split("\n")[0]}\n初始版本 V1.0.0 已提交;项目路径:${target}`;
    }),
  );

  ipcMain.handle(CH.pickParentDir, () =>
    wrap(async () => {
      const r = await dialog.showOpenDialog(getWin()!, {
        properties: ["openDirectory", "createDirectory"],
        title: "选择新项目的存放位置(将在其下创建项目文件夹)",
        buttonLabel: "选择此位置",
      });
      if (r.canceled || r.filePaths.length === 0) return null;
      return r.filePaths[0]!;
    }),
  );
}

async function wsAppendAuditSafe(repo: string, op: string, detail: string): Promise<void> {
  try {
    await ws.wsAppendAudit(repo, "gui", op, detail);
  } catch {
    /* 忽略审计失败 */
  }
}
