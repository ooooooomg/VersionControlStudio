import * as nodeFs from "node:fs";

type Win = { webContents: { send: (ch: string, payload?: unknown) => void; isDestroyed(): boolean } } | null;

let current: nodeFs.FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;

/** 递归监视工作区仓库;main/ 与版本目录有变化 → 防抖 500ms 通知渲染端刷新 */
export function watchRepo(repo: string | null, getWin: () => Win): void {
  stopWatch();
  if (!repo) return;
  try {
    current = nodeFs.watch(
      repo,
      { recursive: true } as nodeFs.WatchOptions,
      (_event, filename) => {
        const rel = typeof filename === "string" ? filename.replaceAll("\\", "/") : "";
        if (
          rel.includes("node_modules") ||
          rel.startsWith(".git") ||
          // 并行分支工作树与 temp 补救区是别的会话的领地,变化不算本项目内容
          rel.startsWith(".vcs/branch/") ||
          rel.startsWith("temp/")
        )
          return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const w = getWin();
          if (w && !w.webContents.isDestroyed()) w.webContents.send("pvc:v1:changed");
        }, 500);
      },
    );
  } catch {
    /* 仓库目录可能暂时不可监视;GUI 仍有手动刷新 */
  }
}

export function stopWatch(): void {
  current?.close();
  current = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
