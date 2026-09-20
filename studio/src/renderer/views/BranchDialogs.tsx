/** 新建/导入分支弹窗(V1.26.0 引入;V1.34.0 起从页面组件抽出,供顶栏切换器与版本管理页共用) */
import { useState } from "react";
import { pvc, type AiClientInfo, type WsPublishBranchView } from "../pvc";

/** 工具接入名(路由 key):内置=id,自定义=去 custom: 前缀(与设置页 slugOf 同规则) */
export const slugOf = (c: AiClientInfo) => (c.kind === "custom" ? c.id.replace(/^custom:/, "") : c.id);

/** 新建分支弹窗:分支起点/短名/管理工具/修改目的(必填)/修改内容(可选) */
export function CreateDialog(p: {
  clients: AiClientInfo[];
  base: string;
  busy: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [base, setBase] = useState(p.base);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [detail, setDetail] = useState("");
  const [assignee, setAssignee] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const submit = async () => {
    if (!purpose.trim()) {
      setErr("修改目的必填:说清这个分支要做什么(可按 1. 2. 3. 分点)");
      return;
    }
    setErr("");
    try {
      const requirement = detail.trim() ? `${purpose.trim()}\n${detail.trim()}` : purpose.trim();
      const r = await pvc.wsBranchBegin({
        requirement,
        name: name.trim() || undefined,
        assignee: assignee || undefined,
        base: base.trim() || undefined,
      });
      const short = r.branch.replace("vcs/task/", "");
      setMsg(`已创建分支 ${short}${assignee ? `(指派 ${assignee})` : ""}${base.trim() ? `(基点 ${base.trim()})` : ""}`);
      await p.onDone();
    } catch (e) {
      setErr(`创建失败:${(e as Error).message}`);
    }
  };

  return (
    <div className="bb-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="bb-modal">
        <h3>新建分支</h3>
        <label className="bb-rowfield">
          <span>分支起点</span>
          <input placeholder="V 版本号(如 V1.10.0),留空=从最新开始" value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="bb-rowfield">
          <span>分支短名</span>
          <input placeholder="留空自动生成;B 编号按起点+检查点序自动编排" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="bb-rowfield">
          <span>管理工具</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">不指派</option>
            {p.clients.map((c) => (
              <option key={c.id} value={slugOf(c)}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="bb-rowfield">
          <span>修改目的(必填)</span>
          <textarea rows={2} placeholder="请简要描述修改主要目的(可按 1. 2. 3. 分点)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label className="bb-rowfield">
          <span>修改内容(可选)</span>
          <textarea rows={2} placeholder="请描述修改主要变化" value={detail} onChange={(e) => setDetail(e.target.value)} />
        </label>
        {err && <div className="nb-msg nb-err">{err}</div>}
        {msg && <div className="nb-msg nb-ok">{msg}</div>}
        <div className="bb-submit">
          <button className="btn" disabled={p.busy} onClick={() => void submit()}>确认新建分支</button>
        </div>
      </div>
    </div>
  );
}

/** 导入分支弹窗:把仓库现存未登记的 vcs/task/* 孤儿分支纳入管理 */
export function ImportDialog(p: {
  clients: AiClientInfo[];
  orphans: string[];
  busy: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(p.orphans[0] ?? "");
  const [purpose, setPurpose] = useState("");
  const [assignee, setAssignee] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const submit = async () => {
    if (!name.trim()) {
      setErr("请选择要导入的分支");
      return;
    }
    if (!purpose.trim()) {
      setErr("修改目的必填:记录该分支的用户需求");
      return;
    }
    setErr("");
    try {
      const r = await pvc.wsBranchAdopt({ name: name.trim(), requirement: purpose.trim(), assignee: assignee || undefined });
      setMsg(r);
      await p.onDone();
    } catch (e) {
      setErr(`导入失败:${(e as Error).message}`);
    }
  };

  return (
    <div className="bb-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="bb-modal">
        <h3>导入分支</h3>
        {p.orphans.length === 0 ? (
          <div className="dim" style={{ margin: "8px 0 16px" }}>
            没有可导入的分支 —— 仓库里现存的所有 vcs/task/* 分支都已在管理中。
          </div>
        ) : (
          <>
            <label className="bb-rowfield">
              <span>选择分支</span>
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {p.orphans.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="bb-rowfield">
              <span>管理工具</span>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">不指派</option>
                {p.clients.map((c) => (
                  <option key={c.id} value={slugOf(c)}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="bb-rowfield">
              <span>修改目的(必填)</span>
              <textarea rows={2} placeholder="这条分支当初要做什么(补记)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            </label>
          </>
        )}
        {err && <div className="nb-msg nb-err">{err}</div>}
        {msg && <div className="nb-msg nb-ok">{msg}</div>}
        <div className="bb-submit">
          {p.orphans.length > 0 ? (
            <button className="btn" disabled={p.busy} onClick={() => void submit()}>确认导入分支</button>
          ) : (
            <button className="btn sec" onClick={p.onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 发布分支只读详情(V1.35.0):顶栏切换器「发布」节点击弹出——指向提交/日期/说明 + 根文件清单 */
export function PublishDialog(p: { info: WsPublishBranchView; onClose: () => void }) {
  return (
    <div className="bb-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="bb-modal">
        <h3>发布分支 · {p.info.version}</h3>
        <div className="dim ip-meta">
          分支 {p.info.branch} · 指向提交 {p.info.sha.slice(0, 10)} · {p.info.date}
        </div>
        {p.info.subject && <div className="ip-req" style={{ margin: "8px 0" }}>{p.info.subject}</div>}
        <div className="dim" style={{ margin: "10px 0 4px" }}>内容清单(根一级):</div>
        <div className="pub-files">
          {p.info.files.map((f) => (
            <div key={f} className="pub-file mono">{f}</div>
          ))}
        </div>
        <div className="dim ip-meta" style={{ marginTop: 10 }}>
          发布分支是定版内容的导出快照,只读;更新发布内容请走正常版本流程后重做发布。
        </div>
        <div className="bb-submit">
          <button className="btn sec" onClick={p.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
