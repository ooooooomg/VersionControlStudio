import { useCallback, useEffect, useMemo, useState } from "react";
import { pvc, type AiClientInfo, type StudioSettings, type WsInProgressView, type WsParallelView, type WsPublishBranchView, type WsVersionView } from "./pvc";
import { Home } from "./views/Home";
import { VersionsView } from "./views/VersionsView";
import { CreateDialog, ImportDialog, PublishDialog } from "./views/BranchDialogs";
import { branchLabelsOf } from "./views/TimelineGraph";
import { CompareView } from "./views/CompareView";
import { SettingsView } from "./views/SettingsView";

type View = "home" | "versions" | "compare" | "settings";

/** 导航线性图标:与标志同一黑白锐角语言(方角/直线,禁圆角曲线) */
function NavIcon({ d }: { d: string[] }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      {d.map((p, i) => (
        <path key={i} d={p} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" />
      ))}
    </svg>
  );
}

const NAV_ICONS: Record<View, string[]> = {
  home: ["M3.5 6.5h6l2 3h9v10h-17z"], // 项目:方角文件夹
  versions: ["M3 12h18", "M6 9.5h5v5H6z", "M13.5 9.5h5v5h-5z"], // 版本管理:轴线+两个版本节点
  compare: ["M9.5 5 3.5 12l6 7", "M14.5 5l6 7-6 7"], // 对比:相向双箭
  settings: ["M4 7h16", "M4 12h16", "M4 17h16", "M8.5 5h4v4h-4z", "M12.5 10h4v4h-4z", "M7.5 15h4v4h-4z"], // 设置:滑杆
};

const NAV: { view: View; label: string }[] = [
  { view: "home", label: "我的项目" },
  { view: "versions", label: "版本管理" },
  { view: "compare", label: "版本对比" },
  { view: "settings", label: "设置" },
];

export function App() {
  const [view, setView] = useState<View>("home");
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [versions, setVersions] = useState<WsVersionView[] | null>(null);
  const [cmp, setCmp] = useState<{ from?: string; to?: string }>({});
  const [reloadKey, setReloadKey] = useState(0);
  // 并行分支视图(侧栏徽章计数 + 版本管理页数据源)
  const [parallel, setParallel] = useState<WsParallelView | null>(null);
  const [parCount, setParCount] = useState(0);
  // 刷新进行中:图标旋转 + 内容区淡出,给点击一个可见反馈(至少持续 600ms,避免过快看不到)
  const [refreshing, setRefreshing] = useState(false);
  // 顶栏三件套数据:主轴进行中版本 / 越界文件(状态胶囊三色)/ AI 工具清单(切换器弹窗+改派)
  const [ip, setIp] = useState<WsInProgressView | null>(null);
  const [offenders, setOffenders] = useState<string[]>([]);
  const [clients, setClients] = useState<AiClientInfo[]>([]);
  // 发布分支(publish/*,只读):切换器「发布」节 + 切换器胶囊小圆点
  const [pubBranches, setPubBranches] = useState<WsPublishBranchView[]>([]);
  const [pubInfo, setPubInfo] = useState<WsPublishBranchView | null>(null);
  // 版本管理查看上下文(main 或分支短名)与切换器下拉、新建/导入弹窗(顶栏与页内共用)
  const [vmCtx, setVmCtx] = useState<string>("main");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [vmDialog, setVmDialog] = useState<{ mode: "create"; base: string } | { mode: "import" } | null>(null);
  // 侧栏宽度:手动拖拽调节,localStorage 记住偏好
  const [navWidth, setNavWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pvc.navWidth"));
    // 64 = 收起的仅图标模式;140~420 = 文字模式
    return Number.isFinite(v) && (v === 64 || (v >= 140 && v <= 420)) ? v : 190;
  });
  const [resizing, setResizing] = useState(false);

  // 侧栏宽度阈值:拖到 100px 以下自动切换为仅图标模式(64px),拉宽恢复文字
  const collapsed = navWidth < 100;

  const startNavResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = navWidth;
    setResizing(true);
    document.body.classList.add("nav-resizing");
    const onMove = (ev: MouseEvent) => {
      const raw = startW + ev.clientX - startX;
      setNavWidth(raw < 100 ? 64 : Math.min(420, Math.max(140, raw)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("nav-resizing");
      setResizing(false);
      setNavWidth((w) => {
        localStorage.setItem("pvc.navWidth", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const refresh = useCallback(async () => {
    const load = async <T,>(f: () => Promise<T>, fb: T): Promise<T> => {
      try {
        return await f();
      } catch {
        return fb;
      }
    };
    try {
      const s = await pvc.settingsGet();
      setSettings(s);
      if (!s.repoPath) {
        setVersions(null);
        setParallel(null);
        setParCount(0);
        setIp(null);
        setOffenders([]);
        setPubBranches([]);
      } else {
        setVersions(await load(() => pvc.wsVersions(), null));
        const par = await load(() => pvc.wsParallel(), null);
        setParallel(par);
        setParCount(par ? par.branches.length + par.temps.length + (par.mergeInProgress ? 1 : 0) : 0);
        setIp(await load(() => pvc.wsInProgress(), null));
        setOffenders(await load(() => pvc.wsOffenders(), []));
        setPubBranches(await load(() => pvc.wsPublishBranches(), []));
      }
    } catch {
      /* 保持空态 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = pvc.onChanged(() => void refresh());
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (t === undefined && !document.hidden) t = setInterval(() => void refresh(), 15000);
    };
    const stop = () => {
      if (t !== undefined) {
        clearInterval(t);
        t = undefined;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
        void refresh(); // 回到前台立即刷新一次,不等 15s
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      off();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, reloadKey]);

  useEffect(() => {
    const theme = settings?.theme ?? "dark";
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    document.documentElement.setAttribute("data-theme", theme);
  }, [settings?.theme]);

  // 切换工作区回到 main 视图;AI 工具清单(新建/导入弹窗与详情改派共用)随工作区拉取
  useEffect(() => {
    setVmCtx("main");
    setCtxOpen(false);
    if (!settings?.repoPath) {
      setClients([]);
      return;
    }
    void pvc.aiClients().then(setClients).catch(() => setClients([]));
  }, [settings?.repoPath]);

  // 所选分支被合并/丢弃后回退 main
  useEffect(() => {
    if (vmCtx !== "main" && !(parallel?.branches ?? []).some((b) => b.name === vmCtx)) setVmCtx("main");
  }, [parallel, vmCtx]);

  const bump = () => {
    setReloadKey((k) => k + 1);
    setRefreshing(true);
    const started = Date.now();
    void refresh().then(() => {
      // 刷新至少演示 600ms,保证用户能感知到反馈
      setTimeout(() => setRefreshing(false), Math.max(0, 600 - (Date.now() - started)));
    });
  };

  const createProject = async () => {
    const s = await pvc.pickRepo();
    if (!s?.repoPath) return;
    const list = await pvc.projectsList();
    const cur = list.find((x) => x.repoPath === s.repoPath);
    if (!cur?.isWorkspace) {
      const title = s.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "新项目";
      await pvc.wsInit({ dir: s.repoPath, title });
    }
    bump();
    setView("versions");
  };

  const openProject = async (repoPath: string, isWorkspace: boolean) => {
    await pvc.setRepo(repoPath);
    bump();
    setView(isWorkspace ? "versions" : "settings");
  };

  const latest = versions && versions.length > 0 ? versions[versions.length - 1]!.code : null;
  const title =
    view === "home"
      ? "我的项目"
      : (settings?.repoPath ? settings.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "" : "未选择工作区");

  // 顶栏三件套状态胶囊:红=越界文件/合并冲突(优先),黄=主轴进行中/当前分支未提交,绿=正常
  const branches = parallel?.branches ?? [];
  const branchLabels = useMemo(() => branchLabelsOf(branches), [parallel]);
  const selBranch = vmCtx === "main" ? null : branches.find((b) => b.name === vmCtx) ?? null;
  const badReasons: string[] = [];
  if (offenders.length > 0) badReasons.push(`越界文件 ${offenders.length} 处`);
  if (parallel?.mergeInProgress) badReasons.push(`合并冲突处理中(${parallel.mergeInProgress.name})`);
  const warnReasons: string[] = [];
  if (ip) warnReasons.push(`${ip.code} 进行中`);
  if (selBranch && selBranch.dirty > 0) warnReasons.push(`分支 ${selBranch.dirty} 处未提交`);
  const stateLevel: "ok" | "warn" | "bad" = badReasons.length > 0 ? "bad" : warnReasons.length > 0 ? "warn" : "ok";
  const stateTip =
    stateLevel === "bad"
      ? `不合规:${badReasons.join(";")}——处理后版本才能正常收尾`
      : stateLevel === "warn"
        ? `正在编辑:${warnReasons.join(";")}`
        : "正常:无进行中版本、无越界文件";

  return (
    <>
      <div className={"nav" + (collapsed ? " collapsed" : "")} style={{ width: collapsed ? 64 : navWidth, minWidth: collapsed ? 64 : navWidth }}>
        <div className="logo">
          <svg width="30" height="30" viewBox="0 0 512 512" aria-hidden="true">
            <rect width="512" height="512" rx="75.57" fill="#000000"/>
            <path fill="#ffffff" d="M 204.80 458.11 A 208.49 208.49 0 1 1 307.20 458.11 L 268.49 411.65 A 156.15 156.15 0 1 0 243.51 411.65 L 204.80 458.11 Z M 238.20 192.47 L 201.07 131.19 A 136.36 136.36 0 1 0 310.93 131.19 L 273.80 192.47 A 65.98 65.98 0 1 1 238.20 192.47 Z"/>
          </svg>
          <span className="logo-text">VersionControl Studio</span>
        </div>
        {NAV.map(({ view: v, label }) => (
          <button
            key={v}
            className={"nav-item" + (view === v ? " active" : "")}
            title={collapsed ? label : undefined}
            onClick={() => setView(v)}
          >
            <span className="nav-ico"><NavIcon d={NAV_ICONS[v]} /></span>
            <span className="nav-label">{label}</span>
            {v === "versions" && parCount > 0 && <span className="nav-badge">{parCount}</span>}
          </button>
        ))}
        <div className="spacer" />
      </div>
      <div
        className={"nav-resizer" + (resizing ? " dragging" : "")}
        title={collapsed ? "向右拖拽展开菜单" : "拖拽调节菜单栏宽度(拖至最窄自动收起为图标)"}
        onMouseDown={startNavResize}
      />
      <div className="main">
        <div className="topbar">
          <div className="title">{title}</div>
          {view !== "home" && settings?.repoPath ? (
            /* 右上三件套(设计稿版式):状态版本号胶囊 + 分支切换器 + 圆形刷新 */
            <div className="vm-cluster">
              {latest && (
                <span className={`vm-verpill mono state-${stateLevel}`} title={stateTip}>
                  {latest}
                </span>
              )}
              <div className="vm-switcher">
                <button className="vm-switch-btn" onClick={() => setCtxOpen((v) => !v)} title="切换查看的分支">
                  {vmCtx === "main" ? "main" : branchLabels.get(vmCtx) ?? vmCtx}
                  {pubBranches.length > 0 && (
                    <span
                      className="vm-pub-dot"
                      title={`已有发布分支:${pubBranches.map((b) => b.version).join("、")}(下拉底部查看)`}
                    />
                  )}
                </button>
                {ctxOpen && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onMouseDown={() => setCtxOpen(false)} />
                    <div className="vm-menu" style={{ zIndex: 95 }}>
                      <div className="vm-menu-head">选择分支</div>
                      <button className={vmCtx === "main" ? "sel" : ""} onClick={() => { setCtxOpen(false); setVmCtx("main"); }}>
                        main
                      </button>
                      {branches.map((b) => (
                        <button key={b.name} className={vmCtx === b.name ? "sel" : ""} onClick={() => { setCtxOpen(false); setVmCtx(b.name); }}>
                          {branchLabels.get(b.name) ?? b.name}
                          <span className="vm-menu-sub">{b.name}</span>
                        </button>
                      ))}
                      {pubBranches.length > 0 && (
                        <>
                          <div className="vm-menu-sep" />
                          <div className="vm-menu-head">发布分支</div>
                          {pubBranches.map((pb) => (
                            <button key={pb.branch} title="查看发布内容(只读)" onClick={() => { setCtxOpen(false); setPubInfo(pb); }}>
                              {pb.version} 发布
                              <span className="vm-menu-sub">{pb.date}</span>
                            </button>
                          ))}
                        </>
                      )}
                      <div className="vm-menu-sep" />
                      <button onClick={() => { setCtxOpen(false); setVmDialog({ mode: "create", base: "" }); }}>+ 新建分支…</button>
                      <button onClick={() => { setCtxOpen(false); setVmDialog({ mode: "import" }); }}>＞ 导入分支…</button>
                    </div>
                  </>
                )}
              </div>
              <button
                className={"vm-refresh" + (refreshing ? " refreshing" : "")}
                onClick={bump}
                disabled={refreshing}
                title="重新拉取工作区状态与版本信息"
              >
                <svg className="ref-ico" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path
                    d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <button
              className={"btn sec refresh-btn" + (refreshing ? " refreshing" : "")}
              onClick={bump}
              disabled={refreshing}
              title="重新拉取工作区状态与版本信息"
            >
              <svg className="ref-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                <path
                  d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                  fill="currentColor"
                />
              </svg>
              刷新
            </button>
          )}
          {view === "home" && (
            <button
              className="btn sec"
              title="切换视图样式(卡片/列表)"
              onClick={async () => {
                await pvc.setViewStyle(settings?.viewStyle === "cards" ? "list" : "cards");
                bump();
              }}
            >
              {settings?.viewStyle === "cards" ? "☰ 列表" : "▦ 卡片"}
            </button>
          )}
        </div>
        <div className={"content" + (refreshing ? " content-refreshing" : "")}>
          {view === "home" && (
            <Home settings={settings} reloadKey={reloadKey} onOpen={openProject} onCreate={createProject} onChanged={bump} />
          )}
          {view === "versions" && (
            <VersionsView
              versions={versions}
              parallel={parallel}
              ip={ip}
              clients={clients}
              ctx={vmCtx}
              onCtxChange={setVmCtx}
              onOpenDialog={setVmDialog}
              onChanged={bump}
              onCompare={(from, to) => {
                setCmp({ from, to });
                setView("compare");
              }}
            />
          )}
          {view === "compare" && (
            <CompareView versions={versions} initialFrom={cmp.from} initialTo={cmp.to} />
          )}
          {view === "settings" && (
            <SettingsView settings={settings} onChanged={bump} />
          )}
        </div>
      </div>
      {vmDialog?.mode === "create" && (
        <CreateDialog
          clients={clients}
          base={vmDialog.base}
          busy={refreshing}
          onClose={() => setVmDialog(null)}
          onDone={() => {
            setVmDialog(null);
            bump();
          }}
        />
      )}
      {vmDialog?.mode === "import" && (
        <ImportDialog
          clients={clients}
          orphans={parallel?.orphans ?? []}
          busy={refreshing}
          onClose={() => setVmDialog(null)}
          onDone={() => {
            setVmDialog(null);
            bump();
          }}
        />
      )}
      {pubInfo && <PublishDialog info={pubInfo} onClose={() => setPubInfo(null)} />}
    </>
  );
}
