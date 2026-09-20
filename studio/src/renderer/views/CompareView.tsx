import { useEffect, useMemo, useState } from "react";
import { diffLines } from "../linediff";
import { pvc, type DiffFileEntry, type WsVersionView } from "../pvc";

interface Props {
  versions: WsVersionView[] | null;
  initialFrom?: string;
  initialTo?: string;
}

const TEXT_LIMIT = 300 * 1024;

export function CompareView(p: Props) {
  const codes = useMemo(
    () => (p.versions ?? []).map((v) => v.code),
    [p.versions],
  );
  const [selA, setSelA] = useState(p.initialFrom ?? "");
  const [selB, setSelB] = useState(p.initialTo ?? "main");
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState("");
  const [contentA, setContentA] = useState("");
  const [contentB, setContentB] = useState("");
  const [note, setNote] = useState("");
  // 两版本间的文件级差异:下拉列表中 新增=绿 / 改动=黄 / 已删除=红
  const [fileStatus, setFileStatus] = useState<Map<string, DiffFileEntry["status"]>>(new Map());

  useEffect(() => {
    if (!selA || !selB) return;
    setNote("");
    Promise.all([pvc.versionFiles(selA), pvc.versionFiles(selB)])
      .then(([fa, fb]) => {
        const union = [...new Set([...fa, ...fb])]
          .filter((f) => /\.(txt|md|py|js|ts|tsx|json|html|css|c|cpp|h|java|tex|bib|drawio)$/i.test(f) || !f.includes("."))
          .sort();
        setFiles(union);
        setFile((cur) => (cur && union.includes(cur) ? cur : union[0] ?? ""));
      })
      .catch((e: Error) => setNote(e.message));
  }, [selA, selB]);

  useEffect(() => {
    if (!selA || !selB) {
      setFileStatus(new Map());
      return;
    }
    pvc
      .diffFiles(selA, selB)
      .then((list) => setFileStatus(new Map(list.map((e) => [e.file, e.status]))))
      .catch(() => setFileStatus(new Map()));
  }, [selA, selB]);

  useEffect(() => {
    if (!selA || !selB || !file) return;
    setNote("");
    Promise.all([
      pvc.fileAt({ ref: selA, file }).catch(() => ""),
      pvc.fileAt({ ref: selB, file }).catch(() => ""),
    ])
      .then(([a, b]) => {
        setContentA(a);
        setContentB(b);
      })
      .catch((e: Error) => setNote(e.message));
  }, [selA, selB, file]);

  const linesA = useMemo(() => contentA.split("\n"), [contentA]);
  const linesB = useMemo(() => contentB.split("\n"), [contentB]);
  const diff = useMemo(
    () =>
      contentA.length + contentB.length > TEXT_LIMIT
        ? { aChanged: [] as boolean[], bChanged: [] as boolean[], skipped: true }
        : diffLines(linesA, linesB),
    [contentA, contentB],
  );
  const tooBig = diff.skipped;

  const pane = (side: "A" | "B") => {
    const ref = side === "A" ? selA : selB;
    const lines = side === "A" ? linesA : linesB;
    const changed = side === "A" ? diff.aChanged : diff.bChanged;
    return (
      <div className="cmp-pane">
        <div className="cmp-head">
          <select
            value={ref}
            onChange={(e) => (side === "A" ? setSelA : setSelB)(e.target.value)}
          >
            <option value="">— 选择版本 —</option>
            {codes.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="dim" style={{ fontSize: 12 }}>{lines.length} 行</span>
        </div>
        <div className="cmp-body mono">
          {lines.map((l, i) => (
            <div
              key={i}
              className={"dl " + (changed && changed[i] ? (side === "A" ? "del" : "add") : "")}
            >
              <span className="pre">{l || " "}</span>
            </div>
          ))}
          {lines.length === 0 && <div className="dim" style={{ padding: 8 }}>(空)</div>}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 150px)" }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="dim">请选择要对比的版本</span>
        {files.length > 0 && (
          <>
            <span className="dim">文件</span>
            <select value={file} onChange={(e) => setFile(e.target.value)} style={{ maxWidth: 420 }}>
              {files.map((f) => {
                const st = fileStatus.get(f);
                const color =
                  st === "A" ? "var(--green)" : st === "D" ? "var(--red)" : st === "M" ? "var(--amber)" : undefined;
                return (
                  <option key={f} value={f} style={color ? { color } : undefined}>
                    {f}
                  </option>
                );
              })}
            </select>
            {fileStatus.size > 0 && (() => {
              const cnt = (s: DiffFileEntry["status"]) =>
                [...fileStatus.values()].filter((x) => x === s).length;
              return (
                <span className="dim" style={{ fontSize: 12 }}>
                  新增 <span style={{ color: "var(--green)" }}>{cnt("A")}</span> · 改动{" "}
                  <span style={{ color: "var(--amber)" }}>{cnt("M")}</span> · 已删除{" "}
                  <span style={{ color: "var(--red)" }}>{cnt("D")}</span>
                </span>
              );
            })()}
          </>
        )}
        {note && <span className="chip bad">{note}</span>}
        {tooBig && <span className="chip warn">文件过大,差异高亮已关闭</span>}
      </div>
      <div className="cmp-grid">
        {pane("A")}
        {pane("B")}
      </div>
    </div>
  );
}
