import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc.js";

const selfDir = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON = path.join(selfDir, "..", "..", "resources", "icons", "icon.ico");
const SMOKE = process.argv.includes("--smoke");
const AUTO_CLOSE = Number(
  process.argv.find((a) => a.startsWith("--autoclose="))?.split("=")[1] ?? 0,
);

// 单实例:防止多开导致设置文件并发写互相覆盖(审计发现 1)
// smoke 自检跳过该锁,避免与正在运行的实例冲突
let mainWin: BrowserWindow | null = null;
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

async function createWindow(show: boolean): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show,
    autoHideMenuBar: true,
    backgroundColor: "#0e1420",
    title: "VersionControl Studio",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(selfDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("console-message", (_e, _level, message) => {
    if (SMOKE) process.stdout.write(`[renderer] ${message}\n`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    process.stderr.write(`did-fail-load ${code} ${desc}\n`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`RENDER-GONE ${JSON.stringify(details)}\n`);
  });
  win.webContents.on("unresponsive", () => process.stderr.write("RENDER-UNRESPONSIVE\n"));
  await win.loadFile(path.join(selfDir, "../renderer/index.html"));
  return win;
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  try {
    // 自动更新:仅打包态;不自动下载,设置页手动"检查更新"后确认下载安装
    if (app.isPackaged && !SMOKE) {
      autoUpdater.autoDownload = false;
    }
    await registerIpc(() => mainWin);
    mainWin = await createWindow(!SMOKE);
    if (!SMOKE) void ensureGit();
    if (SMOKE) {
      setTimeout(() => {
        process.stdout.write("SMOKE_OK\n");
        app.quit();
      }, 3500);
    }
    if (AUTO_CLOSE > 0) {
      setTimeout(() => app.quit(), AUTO_CLOSE * 1000);
    }
  } catch (err) {
    process.stderr.write(`fatal: ${err}\n`);
    app.quit();
  }
});

/** 开箱引导:本机没有 git 时明确告知安装途径(唯一外部依赖,装完即全功能) */
async function ensureGit(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["--version"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  if (ok || !mainWin || mainWin.isDestroyed()) return;
  const r = await dialog.showMessageBox(mainWin, {
    type: "warning",
    title: "未检测到 Git",
    message: "VersionControl Studio 依赖 Git 记录版本,本机未检测到 Git。",
    detail: [
      "安装任选其一(安装时保持默认选项即可),完成后重启本应用:",
      "· 命令行:winget install --id Git.Git -e",
      "· 官网下载:https://git-scm.com/download/win",
    ].join("\n"),
    buttons: ["打开官网下载页", "复制 winget 命令", "稍后再说"],
    noLink: true,
  });
  if (r.response === 0) await shell.openExternal("https://git-scm.com/download/win");
  else if (r.response === 1) clipboard.writeText("winget install --id Git.Git -e");
}

app.on("window-all-closed", () => app.quit());
