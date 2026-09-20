/** 版本管理(V1.34.0):主轴管理 + 分支管理 合并页。
 *  状态三件套(版本号胶囊/分支切换器/刷新)在窗口顶栏(App),本页只负责:
 *  版本图(强调随切换反转 em-main/em-branch)+ 表格(完全随切换过滤:main=V 行,分支=检查点)
 *  + 详情抽屉 + 右键菜单 + 进行中横幅/合并冲突条/待处理 temp。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MdView } from "../MdView";
import { branchLabelsOf, buildEvents, clientLabel, whoOf, VersionGraph, fmtDay, type TlEvent } from "./TimelineGraph";
import { slugOf } from "./BranchDialogs";
import {
  pvc,
  type AiClientInfo,
  type WsBranchCheckpoint,
  type WsInProgressView,
  type WsParallelView,
  type WsVersionView,
} from "../pvc";

interface Props {
  versions: WsVersionView[] | null;
  /** App 统一拉取并下传的并行分支视图(watcher+15s 全局轮询单一数据源) */
  parallel: WsParallelView | null;
  /** 接管/合并/丢弃等操作后通知 App 刷新 */
  onChanged?: () => void;
  onCompare: (fromCode: string, toCode: string) => void;
  /** 当前查看上下文(main 或分支短名),状态在 App(顶栏切换器共用) */
  ctx: string;
  onCtxChange: (ctx: string) => void;
  /** 顶栏/页内「添加分支」统一走 App 的弹窗状态 */
  onOpenDialog: (d: { mode: "create"; base: string } | { mode: "import" }) => void;
  /** AI 工具清单(改派下拉;App 统一拉取) */
  clients: AiClientInfo[];
  /** 主轴进行中版本(横幅+接管;App 统一拉取) */
  ip: WsInProgressView | null;
}

export function VersionsView(p: Props) {
  const [busy, setBusy] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [changes, setChanges] = useState("");
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [openCls, setOpenCls] = useState(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 节点右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; ev: TlEvent } | null>(null);

  const versions = p.versions ?? [];
  const branches = useMemo(() => p.parallel?.branches ?? [], [p.parallel]);
  const events = useMemo<TlEvent[]>(() => buildEvents(versions, p.parallel), [versions, p.parallel]);
  const latestCode = versions.length > 0 ? versions[versions.length - 1]!.code : null;
  const branchLabels = useMemo(() => branchLabelsOf(branches), [branches]);

  // 选中以 key 记录并从最新清单派生:自动刷新重建数组不丢选中;条目消失(合并/丢弃)自动清空
  const sel = events.find((e) => e.key === selKey) ?? null;
  const selBranch = p.ctx === "main" ? null : branches.find((b) => b.name === p.ctx) ?? null;

  // 表格行完全随切换过滤:main=仅 V 行(新→旧);分支=该分支检查点(新→旧,短编号 B{Y}.{Z}.i)
  const mainRows = useMemo(() => events.filter((e) => e.kind === "v").reverse(), [events]);
  const branchRows = useMemo(() => {
    if (!selBranch) return [];
    const bp = /^V(\d+)\.(\d+)\./.exec(selBranch.baseVersion ?? "");
    const prefix = bp ? `B${bp[1]}.${bp[2]}` : "";
    return events
      .filter((e) => e.kind === "b" && e.b!.task.name === selBranch.name)
      .reverse()
      .map((ev) => ({
        ev,
        label:
          ev.b!.cp.sha === "head"
            ? branchLabels.get(selBranch.name) ?? selBranch.name
            : prefix
              ? `${prefix}.${ev.b!.index}`
              : selBranch.name,
      }));
  }, [events, selBranch, branchLabels]);

  useEffect(() => {
    if (selKey && !events.some((e) => e.key === selKey)) setSelKey(null);
  }, [events, selKey]);

  // 详情栏推拉动画:挂载后下一帧加 open 类触发过渡;关闭先播退场再卸载
  useEffect(() => {
    if (selKey) {
      const id = requestAnimationFrame(() => setOpenCls(true));
      return () => cancelAnimationFrame(id);
    }
    setOpenCls(false);
  }, [selKey]);

  const pick = async (ev: TlEvent) => {
    if (closingTimer.current) {
      clearTimeout(closingTimer.current);
      closingTimer.current = null;
    }
    setClosing(false);
    setSelKey(ev.key);
    const read = (which: "purpose" | "changes", code: string) =>
      pvc.wsReadDoc({ code, which }).catch(() => "");
    try {
      if (ev.v) {
        const purposeMd = filterUserReqLabel(
          filterPurposeMeta(stripDocH1(await read("purpose", ev.v.code))),
        );
        setPurpose(ensurePoints(purposeMd));
        setChanges(ensurePoints(stripDocH1(await read("changes", ev.v.code))));
      } else if (ev.b) {
        setPurpose(ensurePoints(ev.b.task.requirement));
        setChanges(ensurePoints(ev.b.cp.subject));
      }
    } catch {
      /* 读取失败时保留已有内容,避免面板空白 */
    }
  };

  const closeDetail = () => {
    if (closing) return;
    setClosing(true);
    closingTimer.current = setTimeout(() => {
      closingTimer.current = null;
      setClosing(false);
      setSelKey(null);
    }, 300);
  };

  /** 切换查看上下文(main/分支):关闭已开的详情,过滤表格并反转图强调 */
  const switchCtx = (next: string) => {
    if (next === p.ctx) return;
    if (selKey) closeDetail();
    p.onCtxChange(next);
  };

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      const msg = await fn();
      window.alert(`${label}完成:\n${msg}`);
      p.onChanged?.();
    } catch (e) {
      window.alert(`${label}失败:${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const mergeBranch = (name: string) => {
    if (!window.confirm(`合并分支 ${name}:主工作区须已收尾;合并成功将生成一个新 V 版本。确认?`)) return;
    void act("合并", () => pvc.wsBranchMerge({ name }));
  };

  const updateBranch = (name: string) => {
    if (!window.confirm(`把主干 main/ 最新内容合入分支 ${name}?工作树有未提交修改时会被拒绝。`)) return;
    void act("合入主干", () => pvc.wsBranchUpdate(name));
  };

  const rollbackBranch = (name: string) => {
    const to = window.prompt(
      `回退分支 ${name} 到哪个检查点?直接确定=回退上一检查点;也可输入序号(1=最新)或 sha 前缀。\n注意:工作树有未提交修改时会被拒绝。`,
    );
    if (to === null) return;
    void act("回退检查点", () =>
      pvc.wsBranchRollback({ name, to: to.trim() || undefined }).catch((e: Error) => {
        if (!/未提交修改/.test(e.message)) throw e;
        if (!window.confirm(`${e.message}\n\n确认放弃这些修改并回退?`)) throw new Error("已取消");
        return pvc.wsBranchRollback({ name, to: to.trim() || undefined, force: true });
      }),
    );
  };

  const discardBranch = (name: string, commits: number) => {
    if (
      !window.confirm(
        `丢弃分支 ${name}?领先 ${commits} 个提交未合并,工作树与分支将删除,未合并的修改不可恢复。` +
          (commits === 0 ? "\n(注意:工作树里尚未存检查点的修改也不计入此数,若有请先在分支工作树内提交检查点)" : ""),
      )
    )
      return;
    void act("丢弃分支", () =>
      pvc.wsBranchDiscard(name).catch((e: Error) => {
        if (!/未提交修改/.test(e.message)) throw e;
        if (!window.confirm(`${e.message}\n\n确认放弃这些修改并丢弃分支?`)) throw new Error("已取消");
        return pvc.wsBranchDiscard(name, true);
      }),
    );
  };

  const reassign = (name: string, assignee: string) => {
    setBusy(true);
    pvc
      .wsBranchAssign({ name, assignee: assignee || undefined })
      .then(() => {
        p.onChanged?.();
      })
      .catch((e) => window.alert(`改派失败:${(e as Error).message}`))
      .finally(() => setBusy(false));
  };

  /** 副本管理:生成(任意版本)/删除回滚物化的项目副本(main/ 与历史不动) */
  const copyOp = async (v: WsVersionView, op: "delete" | "restore") => {
    if (op === "delete") {
      if (
        !window.confirm(
          `删除 V${v.code.slice(1)}/项目副本/?\n\n` +
            `副本只是浏览用快照;该版本内容仍保存在版本历史(tag ${v.code})中,\n` +
            `main/ 与历史不受影响,删除后可随时重新生成。`,
        )
      )
        return;
    } else if (
      !window.confirm(
        `生成 V${v.code.slice(1)}/项目副本/?\n\n` +
          `完整项目副本取自版本历史(tag ${v.code}),main/ 与版本历史不受影响;不用时可在版本详情删除。`,
      )
    )
      return;
    setBusy(true);
    try {
      const msg = op === "delete" ? await pvc.wsDeleteCopy(v.code) : await pvc.wsRestoreCopy(v.code);
      window.alert(msg);
      p.onChanged?.();
    } catch (e) {
      window.alert((op === "delete" ? "删除副本失败:" : "生成副本失败:") + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeover = async (mode: "continue" | "fresh") => {
    if (!p.ip) return;
    let requirement: string | undefined;
    if (mode === "fresh") {
      const input = window.prompt(
        `接管并重开:原半成品(${p.ip.code})将存入 git stash,按新需求开新版本。\n请输入新需求:`,
        p.ip.requirement,
      );
      if (input === null) return;
      requirement = input.trim();
      if (!requirement) {
        window.alert("重开需要填写新需求");
        return;
      }
    } else if (
      !window.confirm(
        `接管并继续 ${p.ip.code}:沿用原需求与半成品,本 GUI 将成为该版本的持有者(写审计)。确认?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const msg = await pvc.wsTakeover({ mode, requirement });
      window.alert(msg);
      p.onChanged?.();
    } catch (e) {
      window.alert("接管失败:" + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyTemp = (name: string) => {
    if (!window.confirm(`应用 temp/${name}:其中保存的变化将写回 main/(应用后需走 begin/commit 定版)。确认?`)) return;
    void act("应用 temp", () => pvc.wsTempApply(name));
  };

  const discardTemp = (name: string) => {
    if (!window.confirm(`丢弃 temp/${name}:其中保存的未提交变化将删除,不可恢复。确认?`)) return;
    void act("丢弃 temp", () => pvc.wsTempDiscard(name));
  };

  if (!p.versions) return <div className="dim">请先在「我的项目」打开一个工作区</div>;

  const empty = events.length === 0 && !p.ip;
  const temps = p.parallel?.temps ?? [];
  /** 该 V 版本号下现存的分支(点击胶囊切换查看第一支) */
  const brsOf = (code: string) => branches.filter((b) => b.baseVersion === code);

  return (
    <div
      className={
        "tl2" +
        (sel
          ? closing
            ? " detail-closing"
            : openCls
              ? " detail-open"
              : ""
          : "")
      }
    >
      <div className="tl2-main">
        {p.ip && (
          <div className="tl-ipbar">
            <span className="code mono">{p.ip.code}</span>
            <span className="badge">进行中</span>
            {p.ip.stalled && <span className="ip-stall">疑似停滞 {p.ip.stallMinutes} 分钟</span>}
            <span className="tl-ip-req" title={p.ip.requirement}>{p.ip.requirement}</span>
            <span className="dim tl-ip-meta">
              活跃 {p.ip.lastActiveAt ?? p.ip.startedAt} · 来源{" "}
              {p.ip.ownerClient ? `${p.ip.ownerSource ?? "未知"}:${p.ip.ownerClient}` : p.ip.ownerSource ?? "未知"}
            </span>
            {p.ip.stalled && (
              <>
                <button className="btn sec" disabled={busy} onClick={() => void takeover("continue")}>
                  接管并继续
                </button>
                <button className="btn sec" disabled={busy} onClick={() => void takeover("fresh")}>
                  接管并重开…
                </button>
              </>
            )}
          </div>
        )}

        {p.parallel?.mergeInProgress && (
          <div className="ip-card card" role="alert">
            <div className="row" style={{ alignItems: "center", gap: 6 }}>
              <span className="code mono">{p.parallel.mergeInProgress.name}</span>
              <span className="ip-stall">合并冲突处理中</span>
            </div>
            <div className="ip-req">{p.parallel.mergeInProgress.requirement}</div>
            {p.parallel.mergeInProgress.conflicts.length > 0 && (
              <div className="dim ip-meta">待解决:{p.parallel.mergeInProgress.conflicts.slice(0, 6).join("、")}
                {p.parallel.mergeInProgress.conflicts.length > 6 ? ` 等 ${p.parallel.mergeInProgress.conflicts.length} 处` : ""}</div>
            )}
            <div className="dim ip-meta">
              由 AI 在 main/ 内修复冲突标记后再次调用 vcs_branch_merge 完成定版,或用 vcs_branch_merge abort:true 干净放弃。
            </div>
          </div>
        )}

        {empty && (
          <div className="dim" style={{ margin: "8px 2px" }}>
            尚无版本 —— 由 AI 在工作区内通过 vcs_begin/vcs_commit 产生;并行分支的检查点也会出现在这里。
          </div>
        )}

        {events.length > 0 && (
          <VersionGraph
            events={events}
            parallel={p.parallel}
            selKey={selKey}
            hoverKey={hoverKey}
            latestCode={latestCode}
            emphasis={selBranch ? "branch" : "main"}
            fillWidth
            onPick={(ev) => void pick(ev)}
            onNodeContext={(ev, x, y) => setMenu({ x, y, ev })}
          />
        )}

        {events.length > 0 && (selBranch ? branchRows.length > 0 : mainRows.length > 0) && (
          <div className="tl-table">
            <div className="tl-tr tl-thead vm4">
              <span>版本号</span>
              <span>主要内容</span>
              <span>更新时间</span>
              <span>提交方</span>
            </div>
            <div className="tl-tbody">
              {selBranch
                ? branchRows.map(({ ev, label }) => (
                    <div
                      key={ev.key}
                      className={"tl-tr vm4" + (selKey === ev.key ? " sel" : "")}
                      onMouseEnter={() => setHoverKey(ev.key)}
                      onMouseLeave={() => setHoverKey((k) => (k === ev.key ? null : k))}
                      onClick={() => void pick(ev)}
                    >
                      <span>
                        <span className="vpill mono vb">{label}</span>
                      </span>
                      <span className="sum" title={ev.title}>{ev.title}</span>
                      <span className="date">{fmtDay(ev.date)}</span>
                      <span className="who">{ev.who}</span>
                    </div>
                  ))
                : mainRows.map((ev) => {
                    const brs = brsOf(ev.v!.code);
                    return (
                    <div
                      key={ev.key}
                      className={"tl-tr vm4" + (selKey === ev.key ? " sel" : "")}
                      onMouseEnter={() => setHoverKey(ev.key)}
                      onMouseLeave={() => setHoverKey((k) => (k === ev.key ? null : k))}
                      onClick={() => void pick(ev)}
                    >
                      <span>
                        <span
                          className={"vpill mono" + (ev.hasCopy ? " copy" : "") + (brs.length > 0 ? " brn" : "")}
                          title={brs.length > 0 ? `${brs.length} 支分支从此版本分叉,点击切换查看` : undefined}
                          style={brs.length > 0 ? { cursor: "pointer" } : undefined}
                          onClick={(e) => {
                            if (brs.length === 0) return;
                            e.stopPropagation();
                            switchCtx(brs[0]!.name);
                          }}
                        >
                          {ev.label}
                        </span>
                      </span>
                      <span className="sum" title={ev.title}>
                        {ev.title}
                        {ev.v?.mergedFrom ? <span className="dim">{` ← ${ev.v.mergedFrom}`}</span> : ""}
                      </span>
                      <span className="date">{fmtDay(ev.date)}</span>
                      <span className="who">{ev.who}</span>
                    </div>
                    );
                  })}
            </div>
          </div>
        )}
        {selBranch && branchRows.length === 0 && (
          <div className="dim" style={{ margin: "8px 2px" }}>该分支暂无事件。</div>
        )}

        {temps.length > 0 && <h3 className="sec-title">待处理 temp({temps.length})</h3>}
        {temps.map((t) => (
          <div key={t.name} className="card br-card">
            <div className="row" style={{ alignItems: "center", gap: 6 }}>
              <span className="code mono">{t.name}</span>
              <span className="badge">{t.files} 处变化</span>
              <span className="badge">{t.source === "gui" ? "人工保存" : "AI 保存"}{t.client ? ` · ${t.client}` : ""}</span>
            </div>
            <div className="ip-req">{t.summary}</div>
            <div className="dim ip-meta">保存于 {t.createdAt} · 基线 {t.baseline.slice(0, 10)}</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sec" disabled={busy} onClick={() => applyTemp(t.name)}>
                恢复应用到 main
              </button>
              <button className="btn sec" disabled={busy} onClick={() => discardTemp(t.name)}>
                丢弃
              </button>
              <button className="btn sec" disabled={busy} onClick={() => void pvc.openItem(`temp/${t.name}`)}>
                打开文件夹
              </button>
            </div>
          </div>
        ))}
      </div>

      {sel && (
        <div className="tl-detail">
          <div className="tl-detail-inner card">
          <button className="tl-close" title="关闭详情" onClick={closeDetail}>
            ×
          </button>
          <div className="detail-head">
            <div className="detail-title row" style={{ gap: 8 }}>
              <span className={"vpill mono" + (sel.kind === "b" ? " vb" : "") + (sel.hasCopy ? " copy" : "")}>
                {sel.label}
              </span>
              {sel.kind === "b" && <span className="badge">分支 {sel.b!.task.name}</span>}
              {sel.hasCopy && <span className="badge">含副本</span>}
            </div>
            <div className="dim">
              {fmtDay(sel.date)} · 提交方 {sel.who}
              {sel.kind === "v" && sel.v ? ` · ${sel.v.source ?? ""}` : ""}
            </div>
          </div>
          <div className="detail-sec">
            <div className="dim">更新目的:</div>
            <MdView text={purpose} />
          </div>
          <div className="detail-sec">
            <div className="dim">更新内容:</div>
            <MdView text={changes} />
          </div>
          {sel.kind === "b" && sel.b && (
            <>
              {(sel.b.task.checkpoints ?? []).length > 0 && (
                <div className="detail-sec">
                  <div className="dim" style={{ marginBottom: 4 }}>检查点(旧→新):</div>
                  {sel.b.task.checkpoints.map((cp: WsBranchCheckpoint) => (
                    <div key={cp.sha} className="dim" style={{ padding: "2px 0", fontSize: 12.5 }}>
                      {cp.date} · {cp.subject.replace(/\s*\[.+\]$/, "")}
                    </div>
                  ))}
                </div>
              )}
              <div className="detail-bottom row">
                <span className="dim" style={{ fontSize: 12 }}>
                  {sel.b.task.commits > 0 ? `${sel.b.task.commits} 个检查点待合并` : "尚无检查点"}
                  {sel.b.task.dirty > 0 ? ` · ${sel.b.task.dirty} 处未提交` : ""}
                  {sel.b.task.assignedClient ? ` · 指派 ${sel.b.task.assignedClient}` : ""}
                </span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <button className="btn sec" disabled={busy} onClick={() => mergeBranch(sel.b!.task.name)}>合并到 main</button>
                <button className="btn sec" disabled={busy} onClick={() => updateBranch(sel.b!.task.name)}>合入主干最新</button>
                <button className="btn sec" disabled={busy} onClick={() => rollbackBranch(sel.b!.task.name)}>回退检查点</button>
                <button className="btn sec" disabled={busy} onClick={() => void pvc.openItem(sel.b!.task.worktree)}>打开工作树</button>
                <button className="btn sec" disabled={busy} onClick={() => discardBranch(sel.b!.task.name, sel.b!.task.commits)}>丢弃</button>
              </div>
              <label className="dim" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 10 }}>
                改派
                <select
                  value={sel.b.task.assignedClient ?? ""}
                  disabled={busy}
                  onChange={(e) => reassign(sel.b!.task.name, e.target.value)}
                >
                  <option value="">不指派</option>
                  {p.clients.map((c) => (
                    <option key={c.id} value={slugOf(c)}>{c.name}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {sel.kind === "v" && sel.v && (
            <>
              {(sel.v.hasCopy || sel.v.materialized) && (
                <div className="detail-sec">
                  <span className="dim">
                    {sel.v.hasCopy
                      ? `已物化完整项目副本(V${sel.v.code.slice(1)}/项目副本/,浏览用快照)。`
                      : `曾物化的项目副本已删除(内容仍在版本历史中,可随时重新生成)。`}
                  </span>
                </div>
              )}
              <div className="detail-bottom row">
                {sel.v.hasCopy ? (
                  <button className="btn sec" disabled={busy} onClick={() => void copyOp(sel.v!, "delete")}>
                    删除副本
                  </button>
                ) : (
                  <button className="btn sec" disabled={busy} onClick={() => void copyOp(sel.v!, "restore")}>
                    生成副本
                  </button>
                )}
                {(() => {
                  const idx = versions.findIndex((x) => x.code === sel.v!.code);
                  const prev = versions[idx - 1];
                  return prev ? (
                    <button className="btn sec" onClick={() => p.onCompare(prev.code, sel.v!.code)}>
                      与上一版 {prev.code} 对比
                    </button>
                  ) : null;
                })()}
                <button className="btn sec" onClick={() => void pvc.openItem(`V${sel.v!.code.slice(1)}`)}>
                  打开文件夹
                </button>
                <button className="btn sec" onClick={() => p.onOpenDialog({ mode: "create", base: sel.v!.code })}>
                  添加分支
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      )}

      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="tl-ctxmenu" style={{ left: menu.x, top: menu.y }}>
            {menu.ev.kind === "v" && menu.ev.v && (
              <>
                <button onClick={() => { const v = menu.ev.v!; setMenu(null); void copyOp(v, "restore"); }}>产生副本</button>
                <button onClick={() => { const v = menu.ev.v!; setMenu(null); void pvc.openItem(`V${v.code.slice(1)}`); }}>打开文件夹</button>
              </>
            )}
            {menu.ev.kind === "b" && menu.ev.b && (
              <button onClick={() => { const t = menu.ev.b!.task; setMenu(null); void pvc.openItem(t.worktree); }}>打开工作树</button>
            )}
            <button
              onClick={() => {
                const base = menu.ev.kind === "v" ? menu.ev.v!.code : menu.ev.b!.cp.sha;
                setMenu(null);
                p.onOpenDialog({ mode: "create", base });
              }}
            >
              添加分支
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 版本文档自带 H1 标题(如「# 更新目的 —— V1.2.0」)与面板标签重复,渲染时剥去开头 H1 及紧随的分隔线/空行 */
function stripDocH1(md: string): string {
  const lines = md.split("\n");
  if (!lines[0]?.startsWith("# ")) return md;
  let i = 1;
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.trim() === "---")) i++;
  return lines.slice(i).join("\n");
}

/** 更新目的里的日期/级别是登记元信息(时间与版本号在详情头部已有),面板只保留目的本身;迁移版本的「原编号」属来源信息,保留 */
function filterPurposeMeta(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^\s*-\s*(日期|级别)\s*:/.test(l))
    .join("\n");
}

/** 「- 用户需求:」标签不参与渲染:单独成行的标签整行去掉;老格式标签与需求同行时只剥前缀(兼容桥进程滞后生成的旧文档) */
function filterUserReqLabel(md: string): string {
  return md
    .split("\n")
    .map((l) => l.replace(/^-\s*用户需求:\s*/, ""))
    .join("\n");
}

/** 无列表结构的内容整体作为单点呈现(更新目的/更新内容一律编号分点) */
function ensurePoints(md: string): string {
  const t = md.trim();
  if (!t) return t;
  return /^\d+\.\s/m.test(t) ? t : `1. ${t.replaceAll("\n", " ")}`;
}
