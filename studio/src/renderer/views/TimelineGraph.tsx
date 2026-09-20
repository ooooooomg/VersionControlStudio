/** 版本图共享模块(V1.32.0):时间线(主轴管理)与分支管理页共用的
 *  事件模型、事件构建与 SVG 版本图(主线 V 节点 + B 分支轨道)。
 *  抽取自 Timeline.tsx,行为保持不变;交互:点击节点、悬停高亮+平滑跟随、右键回调。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WsBranchCheckpoint, WsBranchTaskView, WsParallelView, WsVersionView } from "../pvc";

/** 时间线事件:V=已定版版本(主线),B=并行分支检查点(轨道) */
export interface TlEvent {
  key: string;
  kind: "v" | "b";
  /** 展示编号:V1.2.1 / B1.1.0(按分叉点编号) */
  label: string;
  /** 主要内容(V=改动摘要;B=提交说明) */
  title: string;
  /** "YYYY-MM-DD HH:MM" */
  date: string;
  who: string;
  hasCopy: boolean;
  v?: WsVersionView;
  b?: { task: WsBranchTaskView; cp: WsBranchCheckpoint; index: number };
}

/** 工具接入名 → 展示名(与设置页 classifyClient 同口径) */
export function clientLabel(client?: string): string | null {
  if (!client) return null;
  const n = client.toLowerCase();
  if (n.includes("zcode")) return "ZCode";
  if (n.includes("claude")) return "Claude";
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("vscode") || n.includes("copilot")) return "VS Code Copilot";
  if (n.includes("windsurf") || n.includes("codeium")) return "Windsurf";
  return client;
}

/** 提交方列:接入名优先,无身份的记录按通道兜底(V1.18.0 前的旧记录无身份字段,显示「未记录」) */
export function whoOf(x: { client?: string; source?: string; origin?: string }): string {
  if (x.origin) return "历史导入";
  const c = clientLabel(x.client);
  if (c) return c;
  if (x.source === "gui") return "人工";
  if (x.source === "cli") return "CLI";
  if (x.source === "api") return "接口";
  return "未记录";
}

/** "2026-09-14 10:30" → 表格展示 "2026-9-14"(去前导零,与设计稿一致) */
export function fmtDay(date: string): string {
  const day = date.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[1]}-${Number(m[2])}-${Number(m[3])}` : day;
}

/** 分叉点编号前缀:baseVersion=V1.1.0 → B1.1(检查点序号由调用方追加) */
function basePrefix(t: WsBranchTaskView): string {
  const m = /^V(\d+)\.(\d+)\.\d+$/.exec(t.baseVersion ?? "");
  return m ? `B${m[1]}.${m[2]}` : "";
}

/** 分支切换器展示名(V1.34.0):基点式(设计稿「V1.1.0 B」);同基点多支按登记顺序追加 ·2/·3 */
export function branchLabelsOf(branches: WsBranchTaskView[]): Map<string, string> {
  const count = new Map<string, number>();
  const out = new Map<string, string>();
  for (const b of branches) {
    const base = b.baseVersion ?? "—";
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    out.set(b.name, n === 1 ? `${base} B` : `${base} B·${n}`);
  }
  return out;
}

/** V + B 合并为时间线事件,按更新时间升序(同刻 V 在前);0 检查点分支产出「分支头节点」 */
export function buildEvents(versions: WsVersionView[], parallel: WsParallelView | null): TlEvent[] {
  const out: TlEvent[] = [];
  for (const v of versions) {
    out.push({
      key: v.code,
      kind: "v",
      label: v.code,
      title: v.changes || v.purpose,
      date: v.date,
      who: whoOf(v),
      hasCopy: !!v.hasCopy,
      v,
    });
  }
  for (const t of parallel?.branches ?? []) {
    const prefix = basePrefix(t);
    (t.checkpoints ?? []).forEach((cp, i) => {
      // 标签消歧(V1.30.0):同基点分支的 B 标签相同,混入短名
      const label = prefix ? `${prefix} ${t.name}.${i}` : t.name;
      // 检查点提交方:提交信息尾缀 [接入名](V1.30.0 起 branch-commit 记录)
      const m = /\[(.+)\]$/.exec(cp.subject);
      out.push({
        key: `${t.branch}@${cp.sha}`,
        kind: "b",
        label,
        title: cp.subject.replace(/\s*\[.+\]$/, ""),
        date: cp.date,
        who: m ? clientLabel(m[1]) ?? m[1] : whoOf({ client: t.ownerClient, source: t.ownerSource }),
        hasCopy: false,
        b: { task: t, cp, index: i },
      });
    });
    // 0 检查点的分支也要在时间轴可见(V1.27.0):画「分支头节点」——短名胶囊+需求
    if ((t.checkpoints ?? []).length === 0) {
      const date = t.lastActiveAt ?? t.startedAt;
      out.push({
        key: `${t.branch}@head`,
        kind: "b",
        label: t.name,
        title: t.requirement,
        date,
        who: whoOf({ client: t.assignedClient ?? t.ownerClient, source: t.ownerSource }),
        hasCopy: false,
        b: {
          task: t,
          cp: { sha: "head", subject: "(分支已创建,尚无检查点提交;在工作树内修改后用 vcs_branch_commit 存检查点)", date },
          index: 0,
        },
      });
    }
  }
  return out.sort((a, c) => a.date.localeCompare(c.date) || a.kind.localeCompare(c.kind));
}

const PAD_L = 30;
const PAD_R = 30;
const GAP = 112;

/** 胶囊标签:文字宽估算(mono 12.5px ≈ 7.4px/字符)+ 左右各 11px 内边距(全局统一胶囊规格 V1.35.0,高 22px) */
function pillWidth(label: string): number {
  return label.length * 7.4 + 22;
}

interface GraphRail {
  task: WsBranchTaskView;
  y: number;
  nodes: { x: number; label: string; ev: TlEvent }[];
  forkX: number | null;
}

export function VersionGraph(p: {
  events: TlEvent[];
  parallel: WsParallelView | null;
  selKey: string | null;
  hoverKey?: string | null;
  /** 最新版本号(绿点;缺省取 events 中最后一个 V) */
  latestCode?: string | null;
  /** 视觉侧重(V1.33.0):main=主轴管理(突显主线弱化分支);branch=分支管理(突显分支弱化主线)。缺省 main */
  emphasis?: "main" | "branch";
  /** 主线贯通(V1.33.0):版本少、SVG 窄于容器时,主线延伸到容器右缘 */
  fillWidth?: boolean;
  onPick: (ev: TlEvent) => void;
  onNodeContext?: (ev: TlEvent, x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [wrapW, setWrapW] = useState(0);
  const hoverKey = p.hoverKey !== undefined ? p.hoverKey : hover;
  const emphasis = p.emphasis ?? "main";

  // 贯通:测容器宽,版本少时把 SVG 撑到容器宽(窗口尺寸变化跟随)
  useEffect(() => {
    if (!p.fillWidth) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrapW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.fillWidth]);

  const events = p.events;
  // 默认滚动停在最新版本(最右端);事件数变化时复位
  useEffect(() => {
    const el = wrapRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [events.length]);

  const graph = useMemo(() => {
    const branchList = p.parallel?.branches ?? [];
    const n = events.length;
    const xOf = (i: number) => PAD_L + i * GAP;
    const xByKey = new Map<string, number>();
    events.forEach((e, i) => xByKey.set(e.key, xOf(i)));
    // 布局均衡(V1.31.0):上方留白按实际上轨数收紧
    const MAIN_Y0 = 46;
    const topLevels = Math.ceil(Math.max(0, branchList.length) / 2);
    const botLevels = Math.floor(Math.max(0, branchList.length) / 2);
    const topOff = topLevels > 0 ? 48 * topLevels - 36 : 8;
    const botOff = botLevels > 0 ? 48 * botLevels + 14 : 8;
    const mainY = MAIN_Y0 + topOff;
    // 高度余量须覆盖下轨胶囊的下探(胶囊中心偏移 22 + 半高 11 ≈ 33px),余量 38px
    const height = mainY + botOff + 38;
    const width = PAD_L + Math.max(0, n - 1) * GAP + PAD_R;

    const rails: GraphRail[] = branchList.map((task, i) => {
      const level = Math.floor(i / 2);
      const up = i % 2 === 0;
      const y = up ? mainY - (18 + 44 * level) : mainY + (18 + 44 * level);
      const prefix = basePrefix(task);
      let nodes = (task.checkpoints ?? []).map((cp, ci) => {
        const ev = events.find((e) => e.key === `${task.branch}@${cp.sha}`);
        return { x: ev ? xByKey.get(ev.key)! : PAD_L, label: prefix ? `${prefix}.${ci}` : task.name, ev: ev! };
      }).filter((nd) => !!nd.ev);
      // 0 检查点分支:轨道延伸到分支头节点(否则整条轨不画,分支在时间轴不可见)
      if (nodes.length === 0) {
        const head = events.find((e) => e.key === `${task.branch}@head`);
        if (head) nodes = [{ x: xByKey.get(head.key)!, label: head.label, ev: head }];
      }
      const base = xByKey.get(task.baseVersion ?? "") ?? null;
      return { task, y, nodes, forkX: base };
    });
    return { xByKey, xOf, mainY, height, width, rails };
  }, [events, p.parallel]);

  // 悬停跟随:悬停键变化时,节点不在可视区 ±90px 内则平滑居中
  useEffect(() => {
    if (!hoverKey) return;
    const el = wrapRef.current;
    const x = graph.xByKey.get(hoverKey);
    if (!el || x === undefined) return;
    const viewL = el.scrollLeft + 90;
    const viewR = el.scrollLeft + el.clientWidth - 90;
    if (x >= viewL && x <= viewR) return;
    const target = Math.max(0, Math.min(x - el.clientWidth / 2, el.scrollWidth - el.clientWidth));
    el.scrollTo({ left: target, behavior: "smooth" });
  }, [hoverKey, graph]);

  const latest = p.latestCode ?? [...events].reverse().find((e) => e.kind === "v")?.label ?? null;

  // 贯通:SVG 略溢出容器宽,主线画到最右——视觉上与滚动长图一样贯穿到缘
  const svgWidth = p.fillWidth ? Math.max(graph.width, wrapW + 56) : graph.width;
  const mainlineX2 = p.fillWidth ? Math.max(graph.xOf(events.length - 1), svgWidth) : graph.xOf(events.length - 1);

  return (
    <div className={"tl-graph-wrap" + (emphasis === "branch" ? " em-branch" : " em-main")} ref={wrapRef} role="img" aria-label="版本图">
      <svg className="tl-graph" width={svgWidth} height={graph.height}>
        {graph.rails.map((r) => {
          if (r.nodes.length === 0) return null;
          const first = r.nodes[0]!;
          const last = r.nodes[r.nodes.length - 1]!;
          const startX = r.forkX ?? first.x;
          const bend = Math.min(36, Math.abs(first.x - startX) / 2 + 8);
          return (
            <g key={r.task.branch} className="tl-rail">
              {r.forkX !== null && first.x > r.forkX ? (
                <path
                  d={`M ${startX} ${graph.mainY} C ${startX + bend} ${graph.mainY}, ${first.x - bend} ${r.y}, ${first.x} ${r.y}`}
                  fill="none"
                />
              ) : null}
              <line x1={first.x} y1={r.y} x2={last.x} y2={r.y} />
            </g>
          );
        })}
        {events.some((e) => e.kind === "v") && (
          <line
            className="tl-mainline"
            x1={PAD_L}
            y1={graph.mainY}
            x2={mainlineX2}
            y2={graph.mainY}
          />
        )}
        {events.map((ev) => {
          const x = graph.xByKey.get(ev.key)!;
          const isV = ev.kind === "v";
          const y = isV ? graph.mainY : graph.rails.find((r) => r.task.branch === ev.b!.task.branch)!.y;
          const pillCy = isV ? y + 22 : y < graph.mainY ? y - 22 : y + 22;
          const w = pillWidth(ev.label);
          const selected = p.selKey === ev.key;
          const isLatest = isV && ev.label === latest;
          return (
            <g
              key={ev.key}
              className={"tl-node" + (selected ? " sel" : "") + (hoverKey === ev.key ? " hov" : "")}
              onClick={() => p.onPick(ev)}
              onMouseEnter={() => setHover(ev.key)}
              onMouseLeave={() => setHover((k) => (k === ev.key ? null : k))}
              onContextMenu={(e) => {
                if (!p.onNodeContext) return;
                e.preventDefault();
                p.onNodeContext(ev, e.clientX, e.clientY);
              }}
            >
              <rect x={x - w / 2 - 6} y={pillCy - 15} width={w + 12} height={30} fill="transparent" />
              {isLatest && <circle className="tl-dot latest" cx={x} cy={y} r={4.5} />}
              <circle className={isV ? "tl-dot" : "tl-dot b"} cx={x} cy={y} r={3.5} />
              <rect
                className={"tl-pill" + (isV ? "" : " vb")}
                x={x - w / 2}
                y={pillCy - 11}
                width={w}
                height={22}
                rx={11}
              />
              <text className={"tl-label " + (isV ? "vl" : "bl") + (ev.hasCopy ? " copy" : "")} x={x} y={pillCy + 4.5} textAnchor="middle">
                {ev.label}
              </text>
              {selected && (
                <rect
                  className="tl-selbox"
                  x={x - w / 2 - 4}
                  y={pillCy - 15}
                  width={w + 8}
                  height={30}
                  rx={12}
                  fill="none"
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
