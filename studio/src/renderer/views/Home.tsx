import { useEffect, useMemo, useState } from "react";
import { pvc, type ProjectSummary, type StudioSettings } from "../pvc";

interface Props {
  settings: StudioSettings | null;
  reloadKey: number;
  onOpen: (repoPath: string, isWorkspace: boolean) => void;
  onCreate: () => void;
  onChanged: () => void;
}

export function Home(p: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const style = p.settings?.viewStyle ?? "cards";

  // 新建项目流程:选位置 → 命名 → 创建(标准工作区 + 初始版本 V1.0.0,无 AI 参与)
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void pvc.projectsList().then(setProjects).catch(() => setProjects([]));
  }, [p.settings?.recents.join("|"), p.reloadKey]);

  // 按最后更新时间倒序(无更新的排在最后),新建方框始终在首位
  const sorted = useMemo(() => {
    const key = (x: ProjectSummary) => x.updatedAt ?? x.createdAt ?? "";
    return (projects ?? []).slice().sort((a, b) => key(b).localeCompare(key(a)));
  }, [projects]);

  // 接入已有文件夹:选文件夹 → 设为当前 → 未纳入过则自动初始化为工作区
  const importFolder = async () => {
    setErr("");
    try {
      const s = await pvc.pickRepo();
      if (!s?.repoPath) return;
      const list = await pvc.projectsList();
      const cur = list.find((x) => x.repoPath === s.repoPath);
      if (!cur?.isWorkspace) {
        const title = s.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "已接入项目";
        await pvc.wsInit({ dir: s.repoPath, title });
      }
      p.onChanged();
    } catch (e) {
      setErr((e as Error).message);
      setParent("import-error");
    }
  };

  const startCreate = async () => {
    setErr("");
    const parentDir = await pvc.pickParentDir();
    if (parentDir) {
      setParent(parentDir);
      setName("");
    }
  };

  const doCreate = async () => {
    if (!parent || !name.trim()) return;
    setCreating(true);
    setErr("");
    try {
      const target = await pvc.wsCreate({ parentDir: parent, title: name.trim() });
      setParent(null);
      setName("");
      p.onOpen(target, true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const addTile =
    parent === null ? (
      <div className="proj-card add-tile">
        <button
          className="add-opt"
          onClick={() => void startCreate()}
          title="选择存放位置,命名后自动创建标准工作区"
        >
          <span className="add-label">＋ 新建项目</span>
          <span className="add-desc">选择位置,创建全新工作区</span>
        </button>
        <div className="add-sep" />
        <button
          className="add-opt"
          onClick={() => void importFolder()}
          title="选择一个已有文件夹,自动设为当前并初始化为工作区"
        >
          <span className="add-label">↳ 接入已有文件夹</span>
          <span className="add-desc">把现有文件夹纳入版本管理</span>
        </button>
        {err && <div className="add-err">{err}</div>}
      </div>
    ) : (
      <div className="proj-card">
        <div className="dim" style={{ fontSize: 12, wordBreak: "break-all" }}>{parent}\</div>
        <input
          placeholder="项目名称"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void doCreate()}
          style={{ width: "100%", marginTop: 8 }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" disabled={!name.trim() || creating} onClick={() => void doCreate()}>
            {creating ? "创建中…" : "创建工作区"}
          </button>
          <button className="btn sec" onClick={() => setParent(null)}>取消</button>
        </div>
        {err && <div className="add-err">{err}</div>}
      </div>
    );

  return (
    <div>
      {projects && projects.length === 0 && (
        <div className="card">
          <h3>还没有项目</h3>
          <div className="dim">点击下方「新建项目」选择存放位置并命名:将创建 main/(项目主体)与工作区日志,初始版本为 V1.0.0。</div>
        </div>
      )}

      {style === "cards" ? (
        <div className="proj-grid">
          {addTile}
          {sorted.map((pr) => (
            <div className="proj-card" key={pr.repoPath} title={pr.repoPath}>
              <div className="proj-name">{pr.title}</div>
              <div className="kv" style={{ marginTop: 8 }}>
                <b>当前版本</b>
                {pr.latest ? (
                  <span className="chip ok">{pr.latest}</span>
                ) : pr.isWorkspace ? (
                  <span className="chip">尚无版本</span>
                ) : (
                  <span className="chip warn">未初始化</span>
                )}
              </div>
              <div className="kv"><b>版本数</b><span>{pr.versionCount}</span></div>
              {pr.occupancy?.inProgress && (
                <div className="kv">
                  <b>进行中</b>
                  <span className={"chip " + (pr.occupancy.inProgress.stalled ? "warn" : "ok")}>
                    ● {pr.occupancy.inProgress.ownerClient ?? "未知工具"} · {pr.occupancy.inProgress.code}
                    {pr.occupancy.inProgress.stalled ? " · 疑似停滞" : ""}
                  </span>
                </div>
              )}
              {(pr.occupancy?.branchCount || pr.occupancy?.tempCount || pr.occupancy?.mergeConflict) ? (
                <div className="kv">
                  <b>并行</b>
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    {pr.occupancy?.mergeConflict && <span className="chip warn">合并冲突</span>}
                    {!!pr.occupancy?.branchCount && <span className="chip">{pr.occupancy.branchCount} 分支</span>}
                    {!!pr.occupancy?.tempCount && <span className="chip">{pr.occupancy.tempCount} temp</span>}
                  </span>
                </div>
              ) : null}
              {pr.createdAt && <div className="kv"><b>创建时间</b><span>{pr.createdAt.slice(0, 10)}</span></div>}
              {pr.updatedAt && <div className="kv"><b>最后更新</b><span>{pr.updatedAt.slice(0, 10)}</span></div>}
              <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button className="btn btn-danger-soft" title="移出版本管理(不删除任何文件)"
                  onClick={async () => {
                    if (!window.confirm(`删除项目「${pr.title}」?\n\n仅移出版本管理列表,不会删除 ${pr.repoPath} 中的任何文件。`)) return;
                    try {
                      await pvc.removeProject(pr.repoPath);
                      p.onChanged(); // 重拉设置与项目列表,卡片立即消失
                    } catch (e) {
                      window.alert(`删除失败:${(e as Error).message}`);
                    }
                  }}>
                  删除项目
                </button>
                <button className="btn" onClick={() => p.onOpen(pr.repoPath, pr.isWorkspace)}>
                  查看详情
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="proj-list">
          <div className="proj-row add-tile" onClick={() => void startCreate()}>
            <span className="add-plus">＋</span>
            <span className="add-label">新建项目</span>
          </div>
          <div className="proj-row add-tile" onClick={() => void importFolder()} title="选择一个已有文件夹,自动设为当前并初始化为工作区">
            <span className="add-plus">↳</span>
            <span className="add-label">接入已有文件夹</span>
          </div>
          {parent !== null && (
            <div className="proj-row add-tile">
              <span className="dim" style={{ fontSize: 12, wordBreak: "break-all" }}>{parent}\</span>
              <input
                placeholder="项目名称"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void doCreate()}
                style={{ flex: 1 }}
              />
              <button className="btn" disabled={!name.trim() || creating} onClick={() => void doCreate()}>
                创建
              </button>
              <button className="btn sec" onClick={() => setParent(null)}>取消</button>
            </div>
          )}
          {sorted.map((pr) => (
            <div className="proj-row" key={pr.repoPath} title={pr.repoPath}>
              <span className="proj-name">{pr.title}</span>
              {pr.latest ? (
                <span className="chip ok">{pr.latest}</span>
              ) : pr.isWorkspace ? (
                <span className="chip">尚无版本</span>
              ) : (
                <span className="chip warn">未初始化</span>
              )}
              {pr.occupancy?.inProgress && (
                <span className={"chip " + (pr.occupancy.inProgress.stalled ? "warn" : "ok")}>
                  ● {pr.occupancy.inProgress.ownerClient ?? "未知工具"}
                </span>
              )}
              {pr.occupancy?.mergeConflict && <span className="chip warn">冲突</span>}
              {!!pr.occupancy?.branchCount && <span className="chip">{pr.occupancy.branchCount} 分支</span>}
              {!!pr.occupancy?.tempCount && <span className="chip">{pr.occupancy.tempCount} temp</span>}
              <span className="flex-spacer" />
              <button className="btn sec" onClick={() => p.onOpen(pr.repoPath, pr.isWorkspace)}>
                查看详情
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
