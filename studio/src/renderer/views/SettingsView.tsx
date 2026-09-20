import { useEffect, useState } from "react";
import { pvc, type AiClientInfo, type ClientRoute, type McpConnectionReport, type ProjectSummary, type StudioSettings, type UpdateCheckResult } from "../pvc";

interface Props {
  settings: StudioSettings | null;
  onChanged: () => void;
}

const THEME_OPTIONS: [string, string][] = [
  ["system", "跟随系统"],
  ["dark", "Windows 深色"],
  ["dark-dimmed", "柔和深色"],
  ["dark-hc", "高对比深色"],
  ["light", "浅色"],
  ["light-hc", "高对比浅色"],
  ["nord", "Nord"],
  ["dracula", "Dracula"],
  ["one-dark", "One Dark"],
  ["tokyo-night", "Tokyo Night"],
  ["solarized-dark", "Solarized 深色"],
  ["solarized-light", "Solarized 浅色"],
];

export function SettingsView(p: Props) {
  const [clients, setClients] = useState<AiClientInfo[] | null>(null);
  const [conn, setConn] = useState<McpConnectionReport | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [slugs, setSlugs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [ccName, setCcName] = useState("");
  const [ccMatch, setCcMatch] = useState("");
  const [ccPath, setCcPath] = useState("");
  const [upd, setUpd] = useState<UpdateCheckResult | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  const s = p.settings;

  const refreshAll = () => {
    void pvc.aiClients().then(setClients).catch(() => setClients([]));
    void pvc.mcpConnections().then(setConn).catch(() => setConn(null));
    void pvc.projectsList().then((x) => setProjects(x.filter((y) => y.isWorkspace))).catch(() => setProjects([]));
  };
  useEffect(() => {
    refreshAll();
  }, [s?.recents.join("|")]);

  // 默认选中第一个工具
  useEffect(() => {
    if (selKey === null && clients && clients.length > 0) setSelKey(clients[0]!.id);
  }, [clients, selKey]);

  if (!s) return <div className="dim">加载中…</div>;
  const say = (text: string, err = false) => setMsg({ text, err });

  /** 接入名 = /mcp/<接入名> 的最后一段,也是路由表的 key;缺省取客户端 id */
  const slugOf = (c: AiClientInfo): string =>
    (slugs[c.id] ?? (c.id.startsWith("custom:") ? c.id.slice("custom:".length) : c.id)).trim();
  const routeOf = (c: AiClientInfo): ClientRoute | undefined => s.clientRoutes?.[slugOf(c)];
  const connected = (id: string): boolean => !!conn?.connected[id];

  const saveRoute = async (c: AiClientInfo, patch: Partial<ClientRoute>) => {
    const key = slugOf(c);
    if (!key) return;
    const cur = s.clientRoutes?.[key];
    const next: ClientRoute = {
      repoPath: patch.repoPath !== undefined ? patch.repoPath : cur?.repoPath,
      permission: patch.permission ?? cur?.permission ?? "auto",
      strict: patch.strict ?? cur?.strict ?? false,
    };
    try {
      await pvc.setRoutes(key, next);
      p.onChanged();
    } catch (e) {
      say((e as Error).message, true);
    }
  };

  const renameSlug = async (c: AiClientInfo, nextRaw: string) => {
    const next = nextRaw.trim().replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
    const old = slugOf(c);
    setSlugs((m) => ({ ...m, [c.id]: next }));
    if (!next || next === old) return;
    const oldRoute = s.clientRoutes?.[old];
    if (oldRoute) {
      try {
        await pvc.setRoutes(next, oldRoute);
        await pvc.setRoutes(old, null);
        p.onChanged();
      } catch (e) {
        say((e as Error).message, true);
      }
    }
  };

  const addCustom = async () => {
    if (!ccName.trim() || !ccMatch.trim()) return;
    try {
      const list = [...(s.customClients ?? [])];
      const id = "c-" + Date.now().toString(36);
      list.push({
        id,
        name: ccName.trim(),
        match: ccMatch.trim(),
        configPath: ccPath.trim() || undefined,
      });
      await pvc.setCustomClients(list);
      setCcName("");
      setCcMatch("");
      setCcPath("");
      say(`已添加 ${ccName.trim()}`);
      p.onChanged();
      refreshAll();
      setSelKey("custom:" + id);
    } catch (e) {
      say((e as Error).message, true);
    }
  };

  const removeCustom = async (c: AiClientInfo) => {
    await pvc.setCustomClients((s.customClients ?? []).filter((x) => "custom:" + x.id !== c.id));
    p.onChanged();
    refreshAll();
    setSelKey(null);
  };

  const sel = clients?.find((c) => c.id === selKey) ?? null;

  return (
    <div>
      <div className="card">
        <h3>系统配色</h3>
        <select
          value={s.theme}
          onChange={async (e) => {
            await pvc.setTheme(e.target.value as StudioSettings["theme"]);
            p.onChanged();
          }}
        >
          {THEME_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </div>

      <div className="card">
        <h3>Agent工具连接</h3>
        <div className="set-wrap">
          <div className="set-list">
            <div className="set-list-head">Agent工具</div>
            {(clients ?? []).map((c) => (
              <div
                key={c.id}
                className={"set-item" + (selKey === c.id ? " sel" : "")}
                onClick={() => setSelKey(c.id)}
              >
                <span className={"dot" + (connected(c.id) ? " ok" : "")} />
                {c.name}
              </div>
            ))}
            <div
              className={"set-item set-add" + (selKey === "add" ? " sel" : "")}
              onClick={() => setSelKey("add")}
              title="添加自定义工具"
            >
              +
            </div>
          </div>

          <div className="set-detail">
            {selKey === "add" ? (
              <>
                <h4>添加工具</h4>
                <div className="set-row">
                  <span className="lb">名称</span>
                  <input placeholder="工具名称" value={ccName} onChange={(e) => setCcName(e.target.value)} style={{ width: 200 }} />
                </div>
                <div className="set-row">
                  <span className="lb">识别关键词</span>
                  <input placeholder="匹配握手客户端名" value={ccMatch} onChange={(e) => setCcMatch(e.target.value)} style={{ width: 260 }} />
                </div>
                <div className="set-row">
                  <span className="lb">配置路径</span>
                  <input placeholder="可选,支持一键写入" value={ccPath} onChange={(e) => setCcPath(e.target.value)} style={{ width: 340 }} />
                </div>
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="btn" disabled={!ccName.trim() || !ccMatch.trim()} onClick={() => void addCustom()}>
                    添加
                  </button>
                </div>
              </>
            ) : sel ? (
              <>
                <h4>{sel.name}</h4>
                <div className="set-row">
                  <span className="lb">状态</span>
                  {connected(sel.id) ? (
                    <span className="chip ok">● 已连接 · {conn?.connected[sel.id]?.last.slice(5, 16)} · {conn?.connected[sel.id]?.transport.toUpperCase()}</span>
                  ) : sel.installed ? (
                    <span className="chip">未连接</span>
                  ) : (
                    <span className="chip">未配置</span>
                  )}
                </div>
                <div className="set-row">
                  <span className="lb">接入名</span>
                  <input
                    value={slugOf(sel)}
                    onChange={(e) => setSlugs((m) => ({ ...m, [sel.id]: e.target.value }))}
                    onBlur={(e) => void renameSlug(sel, e.target.value)}
                    style={{ width: 160 }}
                  />
                </div>
                <div className="set-row">
                  <span className="lb">指定项目</span>
                  <select
                    value={routeOf(sel)?.repoPath ?? ""}
                    onChange={(e) => void saveRoute(sel, { repoPath: e.target.value || undefined })}
                    style={{ maxWidth: 260 }}
                  >
                    <option value="">不指定</option>
                    {projects.map((x) => (
                      <option key={x.repoPath} value={x.repoPath}>{x.title}</option>
                    ))}
                  </select>
                </div>
                <div className="set-row">
                  <span className="lb">权限</span>
                  <select
                    value={routeOf(sel)?.permission ?? "auto"}
                    onChange={(e) => void saveRoute(sel, { permission: e.target.value as "auto" | "readonly" })}
                  >
                    <option value="auto">可写</option>
                    <option value="readonly">只读</option>
                  </select>
                </div>
                <div className="set-row">
                  <span className="lb">越界</span>
                  <select
                    value={routeOf(sel)?.strict ? "strict" : "warn"}
                    onChange={(e) => void saveRoute(sel, { strict: e.target.value === "strict" })}
                  >
                    <option value="warn">警告</option>
                    <option value="strict">拒绝</option>
                  </select>
                </div>
                {sel.configPath && (
                  <div className="set-row">
                    <span className="lb">配置文件</span>
                    <span className="mono dim" style={{ wordBreak: "break-all" }}>{sel.configPath}</span>
                  </div>
                )}
                <div className="row" style={{ marginTop: 16 }}>
                  <button
                    className="btn sec"
                    onClick={async () => {
                      try {
                        const sn = await pvc.aiSnippet(sel.id, slugOf(sel) || undefined);
                        await navigator.clipboard.writeText(sn.text);
                        say(`${sel.name} 配置已复制`);
                      } catch (e) {
                        say((e as Error).message, true);
                      }
                    }}
                  >
                    复制配置
                  </button>
                  {(sel.kind === "json-mcp" || (sel.kind === "custom" && sel.configPath)) && (
                    <button
                      className="btn sec"
                      onClick={async () => {
                        try {
                          const r = await pvc.aiWrite(sel.id, slugOf(sel) || undefined);
                          say(`已写入 ${r.file}`);
                          refreshAll();
                        } catch (e) {
                          say((e as Error).message, true);
                        }
                      }}
                    >
                      一键写入
                    </button>
                  )}
                  {sel.kind === "custom" && (
                    <button className="btn sec" onClick={() => void removeCustom(sel)}>
                      删除
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="dim set-empty">选择左侧工具查看配置</div>
            )}
          </div>
        </div>

        <label className="f" style={{ marginTop: 14 }}>最近握手流水</label>
        <div className="result mono" style={{ maxHeight: 150, overflow: "auto" }}>
          {conn && conn.events.length > 0 ? (
            conn.events.map((ev, i) => (
              <div key={i}>
                {ev.time} | {ev.transport.toUpperCase()} | {ev.client}
                {ev.version ? ` v${ev.version}` : ""}
              </div>
            ))
          ) : (
            "暂无记录"
          )}
        </div>
      </div>

      {msg && <div className={"result" + (msg.err ? " err" : "")}>{msg.text}</div>}

      <div className="card">
        <h3>关于与更新</h3>
        {upd?.supported ? (
          <div className="row" style={{ alignItems: "center", gap: 12 }}>
            <span className="dim">
              当前版本 {upd.current}
              {upd.available && upd.version ? ` · 可更新到 ${upd.version}` : upd.version === null && upd.error ? " · 检查失败" : " · 已是最新"}
            </span>
            {upd.available ? (
              <button
                className="btn"
                disabled={updBusy}
                onClick={async () => {
                  setUpdBusy(true);
                  try {
                    await pvc.appUpdateInstall();
                    say("更新包已下载,应用将重启并安装…");
                  } catch (e) {
                    say((e as Error).message, true);
                    setUpdBusy(false);
                  }
                }}
              >
                下载并安装更新
              </button>
            ) : (
              <button
                className="btn sec"
                disabled={updBusy}
                onClick={async () => {
                  setUpdBusy(true);
                  try {
                    setUpd(await pvc.appUpdateCheck());
                  } catch (e) {
                    say((e as Error).message, true);
                  }
                  setUpdBusy(false);
                }}
              >
                {updBusy ? "检查中…" : "检查更新"}
              </button>
            )}
          </div>
        ) : (
          <div className="dim">
            {upd === null ? (
              <button
                className="btn sec"
                disabled={updBusy}
                onClick={async () => {
                  setUpdBusy(true);
                  try {
                    setUpd(await pvc.appUpdateCheck());
                  } catch (e) {
                    say((e as Error).message, true);
                  }
                  setUpdBusy(false);
                }}
              >
                检查更新
              </button>
            ) : (
              "绿色版运行:更新请到 GitHub Releases 页下载新版绿色包。"
            )}
          </div>
        )}
      </div>
    </div>
  );
}
