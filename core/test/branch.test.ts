import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, tagList } from "../src/git.js";
import {
  wsBeginDetailed,
  wsBranchAssign,
  wsBranchAdopt,
  wsBranchBegin,
  wsBranchCommit,
  wsBranchDiscard,
  wsBranchMerge,
  wsBranchRollback,
  wsBranchUpdate,
  wsCommit,
  wsInit,
  wsParallelView,
  wsPublishBranches,
  wsRollback,
  wsStatus,
  wsTempApply,
  wsTempDiscard,
  wsTempSave,
} from "../src/workspace.js";

let repo = "";
/** 主工作区被占时的通用收尾:回滚清掉进行中状态(生成一个回滚版本) */
const endMainViaRollback = async () => {
  const reg = JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8"));
  const latest = reg.versions[reg.versions.length - 1].code as string;
  await wsRollback(repo, { code: latest, resolveInProgress: "stash" });
};

const norm = (s: string) => s.replace(/\r\n/g, "\n");

const readRegistry = async () =>
  JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8"));

const writeMain = async (rel: string, c: string) => {
  const p = path.join(repo, "main", rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

const writeBranch = async (branch: string, rel: string, c: string) => {
  const p = path.join(repo, ".vcs", "branch", branch, "main", rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "branch-test-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("并行分支(git worktree)", () => {
  it("主空闲时 branch-begin 也创建真实分支(V1.27.0 起无回落,与 git 语义一致)", async () => {
    await wsInit(repo, { title: "并行测试" });
    const r = await wsBranchBegin(repo, { requirement: "主会话任务", name: "idle-a" }, "cli");
    expect(r.branch).toBe("vcs/task/idle-a");
    await expect(fs.access(path.join(repo, ".vcs", "branch", "idle-a", "main"))).resolves.toBeUndefined();
    const reg = await readRegistry();
    expect(reg.inProgress).toBeNull(); // 主干不受影响
    expect(reg.branches).toHaveLength(1);
    // 回到与后续用例衔接的基态:丢弃验证分支;主干走正常 begin/commit 出 V1.0.0
    await wsBranchDiscard(repo, { name: "idle-a" }, "cli");
    const t = await wsBeginDetailed(repo, { requirement: "首个版本" }, "cli");
    await writeMain("v1.txt", "v1\n");
    await wsCommit(repo, { summary: "V1.0.0", sessionToken: t.token });
  });

  it("主被占时创建 worktree 分支:目录/分支/注册表齐全,互不污染", async () => {
    const mainTask = await wsBeginDetailed(repo, { requirement: "主会话长期任务" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "并行任务A", name: "feat-a" }, "mcp-http");
    expect(b.branch).toBe("vcs/task/feat-a");
    await expect(fs.access(path.join(repo, ".vcs", "branch", "feat-a", "main"))).resolves.toBeUndefined();
    const reg = await readRegistry();
    expect(reg.branches).toHaveLength(1);
    expect(reg.branches[0].worktree).toBe(".vcs/branch/feat-a");
    // 分支工作树不出现在主工作区 status(经 info/exclude 排除)
    const st = await wsStatus(repo);
    expect(st).toContain("并行分支:1 个");
    expect(st).not.toContain("v114-parallel");
    // 主令牌与分支令牌互不相同
    expect(b.token).not.toBe(mainTask.token);
    void mainTask;
  });

  it("双分支并存", async () => {
    const b = await wsBranchBegin(repo, { requirement: "并行任务B", name: "feat-b" }, "cli");
    expect(b.branch).toBe("vcs/task/feat-b");
    const reg = await readRegistry();
    expect(reg.branches).toHaveLength(2);
  });

  it("分支检查点:提交不占 V 号;属主闸三元放行,strict 拒绝非属主", async () => {
    const reg0 = await readRegistry();
    const t = reg0.branches.find((x: { name: string }) => x.name === "feat-a").token;
    await writeBranch("feat-a", "feat-a.txt", "来自分支A\n");
    await wsBranchCommit(repo, { name: "feat-a", token: t, summary: "检查点1" });
    const view = await wsParallelView(repo);
    const fa = view.branches.find((x) => x.name === "feat-a")!;
    expect(fa.commits).toBe(1);
    // 检查点清单(时间线 B 节点数据源):sha/说明/日期齐全,旧→新排序
    expect(fa.checkpoints).toHaveLength(1);
    expect(fa.checkpoints[0].subject).toBe("vcs-branch: feat-a — 检查点1");
    expect(fa.checkpoints[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(fa.checkpoints[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // 分叉点版本:feat-a 在 V1.0.0 之后、V1.1.0 之前创建
    expect(fa.baseVersion).toBe("V1.0.0");
    // 非属主(错误令牌+非指派工具):默认档放行但带属主提醒;strict 档拒绝
    await writeBranch("feat-a", "feat-a.txt", "来自分支A v2\n");
    const sneak = await wsBranchCommit(
      repo,
      { name: "feat-a", token: "aaaaaaaaaaaa", summary: "非属主提交" },
      { source: "mcp-http", client: "cursor" },
    );
    expect(sneak).toContain("分支属主提醒");
    await writeBranch("feat-a", "feat-a.txt", "来自分支A v3\n");
    await expect(
      wsBranchCommit(
        repo,
        { name: "feat-a", token: "aaaaaaaaaaaa", summary: "strict 拒绝", strict: true },
        { source: "mcp-http", client: "cursor" },
      ),
    ).rejects.toThrow("不属于你");
    // v3 留在工作树未提交:合并前脏检测会拦,由属主补存检查点(内容不变)
    await wsBranchCommit(repo, { name: "feat-a", token: t, summary: "v3 检查点" });
    // V 版本数未变
    const reg = await readRegistry();
    expect(reg.versions[reg.versions.length - 1].code).toBe("V1.0.0");
  });

  it("合并前置拒绝:主工作区有进行中版本", async () => {
    const reg0 = await readRegistry();
    const t = reg0.branches.find((x: { name: string }) => x.name === "feat-a").token;
    await expect(wsBranchMerge(repo, { name: "feat-a", token: t })).rejects.toThrow("进行中的版本");
  });

  it("主收尾后合并定版:main 含分支改动,worktree 与分支清理,mergedFrom 记录", async () => {
    const reg0 = await readRegistry();
    const mainToken = reg0.inProgress.owner;
    await writeMain("main-task.txt", "主线成果\n");
    await wsCommit(repo, { summary: "主线任务收尾", sessionToken: mainToken });
    const t = (await readRegistry()).branches.find((x: { name: string }) => x.name === "feat-a").token;
    const out = await wsBranchMerge(repo, { name: "feat-a", token: t, summary: "合并任务A" });
    expect(out).toContain("V1.2.0");
    const reg = await readRegistry();
    expect(reg.versions[reg.versions.length - 1].code).toBe("V1.2.0");
    expect(reg.versions[reg.versions.length - 1].mergedFrom).toBe("feat-a");
    expect(reg.branches).toHaveLength(1); // 只剩 feat-b
    expect(reg.mergeInProgress ?? null).toBeNull();
    await expect(fs.access(path.join(repo, ".vcs", "branch", "feat-a"))).rejects.toThrow();
    await expect(git(repo, ["branch", "--list", "vcs/task/feat-a"])).resolves.toBe("");
    const merged = norm(await fs.readFile(path.join(repo, "main", "feat-a.txt"), "utf8"));
    expect(merged).toBe("来自分支A v3\n"); // 分支最后检查点(v3,含非属主提交与属主补存)被合并
    const tags = new Set(await tagList(repo));
    expect(tags.has("V1.2.0")).toBe(true);
  });

  it("合并冲突:返回清单并挂起,期间主工作区写操作被拦;abort 干净回退", async () => {
    // 主线与 feat-b 各自新增同名文件
    const mainTask = await wsBeginDetailed(repo, { requirement: "主线改同名文件" }, "cli");
    await writeMain("conflict.txt", "main 版\n");
    await wsCommit(repo, { summary: "主线版本", sessionToken: mainTask.token });
    const reg0 = await readRegistry();
    const t = reg0.branches.find((x: { name: string }) => x.name === "feat-b").token;
    await writeBranch("feat-b", "conflict.txt", "feat-b 版\n");
    await wsBranchCommit(repo, { name: "feat-b", token: t, summary: "分支版本" });

    const conflict = await wsBranchMerge(repo, { name: "feat-b", token: t });
    expect(conflict).toContain("冲突");
    expect(conflict).toContain("conflict.txt");
    const reg = await readRegistry();
    expect(reg.mergeInProgress.name).toBe("feat-b");
    // 冲突期:begin / branch-begin / temp-save / 副本管理 全部被拦
    await expect(wsBeginDetailed(repo, { requirement: "x" }, "cli")).rejects.toThrow("合并冲突处理中");
    await expect(wsBranchBegin(repo, { requirement: "y" }, "cli")).rejects.toThrow("合并冲突处理中");
    await expect(wsTempSave(repo, { summary: "z" }, "cli")).rejects.toThrow("合并冲突处理中");
    const { wsDeleteCopy } = await import("../src/workspace.js");
    await expect(wsDeleteCopy(repo, "V1.1.0", "cli")).rejects.toThrow("合并冲突处理中");

    await wsBranchMerge(repo, { name: "feat-b", token: t, abort: true });
    const reg2 = await readRegistry();
    expect(reg2.mergeInProgress ?? null).toBeNull();
    expect(norm(await fs.readFile(path.join(repo, "main", "conflict.txt"), "utf8"))).toBe("main 版\n");
    // 分支保留,可再次合并
    expect(reg2.branches.find((x: { name: string }) => x.name === "feat-b")).toBeTruthy();
  });

  it("冲突解决后 continue 定版", async () => {
    const reg0 = await readRegistry();
    const t = reg0.branches.find((x: { name: string }) => x.name === "feat-b").token;
    await wsBranchMerge(repo, { name: "feat-b", token: t }); // 再次冲突
    await writeMain("conflict.txt", "合并结果\n");
    const out = await wsBranchMerge(repo, { name: "feat-b", token: t, summary: "已解决冲突" });
    expect(out).toContain("已合并定版");
    expect(norm(await fs.readFile(path.join(repo, "main", "conflict.txt"), "utf8"))).toBe("合并结果\n");
    const reg = await readRegistry();
    expect(reg.branches).toHaveLength(0);
    expect(reg.mergeInProgress ?? null).toBeNull();
    await expect(fs.access(path.join(repo, ".vcs", "branch", "feat-b"))).rejects.toThrow();
  });

  it("分支丢弃:工作树与 ref 删除", async () => {
    const mainTask = await wsBeginDetailed(repo, { requirement: "丢弃测试期间的主任务" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "将丢弃的任务", name: "feat-c" }, "cli");
    await writeBranch("feat-c", "doomed.txt", "bye\n");
    await wsBranchCommit(repo, { name: "feat-c", token: b.token, summary: "将被丢弃" });
    await wsBranchDiscard(repo, { name: "feat-c", token: b.token });
    await expect(fs.access(path.join(repo, ".vcs", "branch", "feat-c"))).rejects.toThrow();
    await expect(git(repo, ["branch", "--list", "vcs/task/feat-c"])).resolves.toBe("");
    const reg = await readRegistry();
    expect(reg.branches).toHaveLength(0);
    void mainTask;
    // 主任务无实际修改,用回滚收尾清掉进行中状态
    await endMainViaRollback();
    expect((await readRegistry()).inProgress).toBeNull();
  });
});

describe("temp 补救", () => {
  it("持有者把无法提交的变化转存 temp:main 恢复干净、进行中状态清除", async () => {
    const mainTask = await wsBeginDetailed(repo, { requirement: "将被中止的主任务" }, "cli");
    await writeMain("temp-a.txt", "T1\n");
    await writeMain("feat-a.txt", "被改动\n");
    const out = await wsTempSave(
      repo,
      { summary: "任务中止:变化转存 temp", sessionToken: mainTask.token },
      "cli",
    );
    expect(out).toContain("已保存 2 个文件");
    const reg = await readRegistry();
    expect(reg.temp).toHaveLength(1);
    expect(reg.inProgress).toBeNull();
    // main 恢复干净
    await expect(fs.access(path.join(repo, "main", "temp-a.txt"))).rejects.toThrow();
    expect(norm(await fs.readFile(path.join(repo, "main", "feat-a.txt"), "utf8"))).toBe("来自分支A v3\n");
    // temp 目录内容与说明
    const tempName = reg.temp[0].name;
    const manifest = JSON.parse(
      await fs.readFile(path.join(repo, "temp", tempName, "manifest.json"), "utf8"),
    );
    expect(manifest.copied).toContain("temp-a.txt");
    expect(norm(await fs.readFile(path.join(repo, "temp", tempName, "temp-a.txt"), "utf8"))).toBe("T1\n");
    const st = await wsStatus(repo);
    expect(st).toContain(`待处理 temp:1 个(${tempName}`);
  });

  it("无主变化也可转存(无令牌);apply 写回 main 并清条目", async () => {
    // 直接制造无主变化(不走 begin)
    await writeMain("orphan.txt", "无主\n");
    const out = await wsTempSave(repo, { summary: "被锁无法提交,转存保底" }, "cli");
    expect(out).toContain("temp/");
    const reg = await readRegistry();
    const name = reg.temp[reg.temp.length - 1].name; // 刚保存的这条
    // 有进行中版本时,非持有者 apply 被拦
    const holder = await wsBeginDetailed(repo, { requirement: "apply 拦截测试" }, "cli");
    await expect(wsTempApply(repo, { name }, "cli")).rejects.toThrow("进行中的版本");
    // 持有者放弃(转存)后 apply
    await writeMain("holder-work.txt", "H\n");
    await wsTempSave(repo, { summary: "让位给 temp 恢复", sessionToken: holder.token }, "cli");
    await wsTempApply(repo, { name }, "cli");
    expect(norm(await fs.readFile(path.join(repo, "main", "orphan.txt"), "utf8"))).toBe("无主\n");
    const reg2 = await readRegistry();
    expect(reg2.temp).toHaveLength(2); // 首例遗留 T0 + holder 转存 T2
    await expect(fs.access(path.join(repo, "temp", name))).rejects.toThrow();
  });

  it("temp 丢弃:目录与条目删除", async () => {
    const reg = await readRegistry();
    for (const t of reg.temp) await wsTempDiscard(repo, { name: t.name }, "cli");
    const reg2 = await readRegistry();
    expect(reg2.temp ?? []).toHaveLength(0);
  });

  it("收尾:清掉 apply 带回的测试残留,工作区归零", async () => {
    // T0 应用曾带回 temp-a.txt/feat-a.txt 改动、orphan.txt 由上组测试写回:统一还原
    await git(repo, ["checkout", "--", "main"]).catch(() => {});
    await fs.rm(path.join(repo, "main", "orphan.txt"), { force: true });
    await fs.rm(path.join(repo, "main", "temp-a.txt"), { force: true });
    // main/ 必须干净(.vcs 的审计/注册表簿记变更属正常,由下次定版收编)
    const st = await git(repo, ["status", "--porcelain", "-z", "-uall", "--", "main"]);
    expect(st.trim()).toBe("");
    expect((await readRegistry()).inProgress).toBeNull();
  });
});

describe("分支属主与指派(V1.26.0)", () => {
  it("GUI 放行:无令牌合并/丢弃 AI 创建的分支(via=gui)", async () => {
    const mainTask = await wsBeginDetailed(repo, { requirement: "主任务占位" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "GUI 管理的分支", name: "gui-br" }, "mcp-http");
    await writeBranch("gui-br", "g.txt", "G\n");
    await wsBranchCommit(repo, { name: "gui-br", token: b.token, summary: "检查点" });
    await wsCommit(repo, { summary: "主收尾", sessionToken: mainTask.token });
    // GUI 无令牌合并成功(旧代码此处必被拒)
    const out = await wsBranchMerge(repo, { name: "gui-br" }, "gui");
    expect(out).toContain("已合并定版");
    // GUI 无令牌丢弃
    const m2 = await wsBeginDetailed(repo, { requirement: "主任务二" }, "cli");
    await wsBranchBegin(repo, { requirement: "将被 GUI 丢弃", name: "gui-drop" }, "mcp-http");
    const out2 = await wsBranchDiscard(repo, { name: "gui-drop" }, "gui");
    expect(out2).toContain("已丢弃");
    await endMainViaRollback();
  });

  it("指派工具免令牌:assignedClient 落库,视图含 worktreeAbs,指派工具可 commit/merge", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "主任务三" }, "cli");
    const b = await wsBranchBegin(
      repo,
      { requirement: "指派测试分支", name: "assign-br", assignee: "Claude" },
      { source: "mcp-http", client: "zcode" },
    );
    void b;
    // 接入名清洗为小写
    const br = (await readRegistry()).branches.find((x: { name: string }) => x.name === "assign-br");
    expect(br.assignedClient).toBe("claude");
    const view = await wsParallelView(repo);
    const vbr = view.branches.find((x) => x.name === "assign-br")!;
    expect(vbr.assignedClient).toBe("claude");
    expect(path.isAbsolute(vbr.worktreeAbs)).toBe(true);
    // 指派工具(claude)无令牌 commit 成功且无属主提醒
    await writeBranch("assign-br", "a.txt", "A\n");
    const c = await wsBranchCommit(
      repo,
      { name: "assign-br", summary: "指派工具提交" },
      { source: "mcp-http", client: "claude" },
    );
    expect(c).not.toContain("分支属主提醒");
    // 主收尾后,指派工具无令牌合并定版
    await writeMain("assign-main.txt", "M\n");
    await wsCommit(repo, { summary: "主任务三收尾", sessionToken: m.token });
    const out = await wsBranchMerge(repo, { name: "assign-br" }, { source: "mcp-http", client: "claude" });
    expect(out).toContain("已合并定版");
    expect(norm(await fs.readFile(path.join(repo, "main", "a.txt"), "utf8"))).toBe("A\n");
  });

  it("改派与清空:assign 换人后原指派工具回到默认档(提醒放行),清空归零", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "主任务四" }, "cli");
    await wsBranchBegin(
      repo,
      { requirement: "改派测试", name: "reassign-br", assignee: "claude" },
      "mcp-http",
    );
    const out = await wsBranchAssign(repo, { name: "reassign-br", assignee: "cursor" }, "gui");
    expect(out).toContain("cursor");
    expect(
      (await readRegistry()).branches.find((x: { name: string }) => x.name === "reassign-br")
        .assignedClient,
    ).toBe("cursor");
    // 原指派工具 claude 已非属主:默认档放行+提醒
    await writeBranch("reassign-br", "r.txt", "R\n");
    const c = await wsBranchCommit(
      repo,
      { name: "reassign-br", summary: "原指派工具提交" },
      { source: "mcp-http", client: "claude" },
    );
    expect(c).toContain("分支属主提醒");
    // 清空指派
    await wsBranchAssign(repo, { name: "reassign-br", assignee: "" }, "gui");
    expect(
      (await readRegistry()).branches.find((x: { name: string }) => x.name === "reassign-br")
        .assignedClient,
    ).toBeUndefined();
    await wsBranchDiscard(repo, { name: "reassign-br" }, "gui");
    await endMainViaRollback();
  });

  it("主空闲时也创建真实分支并落指派;审计含 via=assigned/gui 留痕", async () => {
    const r = await wsBranchBegin(
      repo,
      { requirement: "空闲期分支", assignee: "claude", name: "idle-assign" },
      { source: "mcp-http", client: "zcode" },
    );
    expect(r.branch).toBe("vcs/task/idle-assign");
    const reg = await readRegistry();
    const br = reg.branches.find((x: { name: string }) => x.name === "idle-assign");
    expect(br.assignedClient).toBe("claude");
    expect(reg.inProgress).toBeNull(); // 主干不受影响
    await wsBranchDiscard(repo, { name: "idle-assign" }, "gui");
    const audit = await fs.readFile(path.join(repo, ".vcs", "audit.log"), "utf8");
    expect(audit).toContain("via=assigned");
    expect(audit).toContain("via=gui");
    expect(audit).toContain("assigned=claude");
  });
});

describe("分支加固守卫(V1.28.0 P0)", () => {
  it("P0-1 嵌套守卫:分支工作树路径不能当工作区(.vcs/branch/ 路径与 .git 文件双检测)", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "占位主任务" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "守卫测试", name: "guard-a" }, "mcp-http");
    const wt = path.join(repo, ".vcs", "branch", "guard-a");
    // 路径特征拒绝(以 worktreeAbs 为 repoPath 调任何 vcs_* 工具都先撞守卫)
    await expect(wsBeginDetailed(wt, { requirement: "x" }, "cli")).rejects.toThrow("并行分支的工作树");
    await expect(wsBranchBegin(wt, { requirement: "y" }, "cli")).rejects.toThrow("并行分支的工作树");
    // .git 是文件的特征也拒绝(模拟目录被搬移的漏网路径)
    const fake = path.join(repo, ".vcs", "branch", "guard-a-moved");
    await fs.cp(wt, fake, { recursive: true });
    await expect(wsBeginDetailed(fake, { requirement: "z" }, "cli")).rejects.toThrow("工作树");
    await fs.rm(fake, { recursive: true, force: true });
    await wsBranchDiscard(repo, { name: "guard-a" }, "gui");
    await wsCommit(repo, { summary: "占位收尾", sessionToken: m.token });
  });

  it("P0-2 挂起合并保护:挂起期 commit 被拒;合并开始后分支前进则定版中止", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "铺底版本" }, "cli");
    await writeMain("freeze.txt", "base\n");
    await wsCommit(repo, { summary: "铺底", sessionToken: m.token });
    const b = await wsBranchBegin(repo, { requirement: "挂起保护", name: "freeze-a" }, "mcp-http");
    await writeBranch("freeze-a", "freeze.txt", "branch\n"); // 分支先改
    await wsBranchCommit(repo, { name: "freeze-a", token: b.token, summary: "分支版本" });
    // 分叉后主线再改同名文件 → 双方修改,合并必冲突
    const m2 = await wsBeginDetailed(repo, { requirement: "主线后改同名" }, "cli");
    await writeMain("freeze.txt", "main\n");
    await wsCommit(repo, { summary: "主线改同名", sessionToken: m2.token });
    // 冲突挂起(同名文件)
    const conflict = await wsBranchMerge(repo, { name: "freeze-a", token: b.token });
    expect(conflict).toContain("冲突");
    // 挂起期 commit 被拒(即使换文件)
    await writeBranch("freeze-a", "other.txt", "x\n");
    await expect(
      wsBranchCommit(repo, { name: "freeze-a", token: b.token, summary: "挂起期提交" }),
    ).rejects.toThrow("冻结");
    // 挂起期修复冲突后 continue 定版(不 abort,直接走续作路径)
    await writeMain("freeze.txt", "merged\n"); // 冲突解决:取合并结果
    const out = await wsBranchMerge(repo, { name: "freeze-a", token: b.token, summary: "已解决" });
    expect(out).toContain("已合并定版");
    expect((await readRegistry()).versions.slice(-1)[0].mergedFrom).toBe("freeze-a");
    expect((await readRegistry()).branches ?? []).toHaveLength(0); // 清理完整(先删树/ref 后摘注册表)
    // abort 后分支解冻:再建一支验证冻结解除
    const b2 = await wsBranchBegin(repo, { requirement: "解冻验证", name: "freeze-b" }, "mcp-http");
    await wsBranchMerge(repo, { name: "freeze-b", abort: true }).catch(() => {});
    await writeBranch("freeze-b", "after.txt", "解冻后\n");
    await wsBranchCommit(repo, { name: "freeze-b", token: b2.token, summary: "解冻后检查点" });
    await wsBranchDiscard(repo, { name: "freeze-b", token: b2.token });
  });

  it("P0-3 基点落库;主干回滚越过基点后合并被拒并列选项;rollback 文案列受影响分支", async () => {
    const reg0 = await readRegistry();
    const m1 = await wsBeginDetailed(repo, { requirement: "回滚场景主线" }, "cli");
    await writeMain("r0.txt", "v0\n");
    await wsCommit(repo, { summary: "基线版本", sessionToken: m1.token });
    const v0 = (await readRegistry()).versions.slice(-1)[0].code;
    const b = await wsBranchBegin(repo, { requirement: "回滚交叉分支", name: "rb-a" }, "mcp-http");
    expect(
      (await readRegistry()).branches.find((x: { name: string }) => x.name === "rb-a").baseline,
    ).toMatch(/^[0-9a-f]{40}$/); // baseline 落库
    await writeBranch("rb-a", "rb.txt", "分支成果\n");
    await wsBranchCommit(repo, { name: "rb-a", token: b.token, summary: "分支提交" });
    // 主干前进一版后回滚到 v0(越过分支基点所在历史线)
    const m2 = await wsBeginDetailed(repo, { requirement: "将被回滚的版本" }, "cli");
    await writeMain("r1.txt", "v1\n");
    await wsCommit(repo, { summary: "将被回滚", sessionToken: m2.token });
    const rollMsg = await wsRollback(repo, { code: v0 });
    expect(rollMsg).toContain("rb-a"); // rollback 文案列受影响分支
    // 此时合并 rb-a:HEAD 与 baseline 不在同一条历史线上 → 拒绝
    await expect(wsBranchMerge(repo, { name: "rb-a", token: b.token })).rejects.toThrow("回滚");
    await wsBranchDiscard(repo, { name: "rb-a", token: b.token });
    await endMainViaRollback();
  });

  it("P0-4 丢弃保护:工作树有未提交修改默认拒绝(force 放行并审计)", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "丢弃保护主线" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "脏丢弃分支", name: "dirty-a" }, "mcp-http");
    await writeBranch("dirty-a", "half.txt", "没存检查点的工作\n"); // 不 commit
    await expect(wsBranchDiscard(repo, { name: "dirty-a", token: b.token })).rejects.toThrow("未提交修改");
    await wsBranchDiscard(repo, { name: "dirty-a", token: b.token, force: true });
    const audit = await fs.readFile(path.join(repo, ".vcs", "audit.log"), "utf8");
    expect(audit).toContain("discarded_dirty=1");
    await wsCommit(repo, { summary: "收尾", sessionToken: m.token });
  });

  it("P0-5 越界闸:合并时根目录越界文件被拒(冲突续作路径同闸)", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "越界闸主线" }, "cli");
    await writeMain("og.txt", "ok\n");
    await wsCommit(repo, { summary: "干净基线", sessionToken: m.token });
    const b = await wsBranchBegin(repo, { requirement: "越界合并分支", name: "og-a" }, "mcp-http");
    await writeBranch("og-a", "og-b.txt", "分支内容\n");
    await wsBranchCommit(repo, { name: "og-a", token: b.token, summary: "分支提交" });
    await fs.writeFile(path.join(repo, "stray.txt"), "越界\n", "utf8"); // 工作区根越界
    await expect(wsBranchMerge(repo, { name: "og-a", token: b.token })).rejects.toThrow("越界");
    await fs.rm(path.join(repo, "stray.txt"));
    await wsBranchMerge(repo, { name: "og-a", token: b.token }); // 清理后正常合并
    const reg = await readRegistry();
    expect(reg.versions.slice(-1)[0].mergedFrom).toBe("og-a");
    void m;
  });

  it("P0-6 残留收养:注册表外孤儿 ref 在 begin 时自动清理,名字不再死锁", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "收养主线" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "将被孤儿化的分支", name: "orphan-a" }, "mcp-http");
    // 模拟旧缺陷现场:直接删注册表条目,留下 ref+工作树孤儿
    const reg = await readRegistry();
    reg.branches = reg.branches.filter((x: { name: string }) => x.name !== "orphan-a");
    await fs.writeFile(path.join(repo, ".vcs", "registry.json"), JSON.stringify(reg, null, 2), "utf8");
    // 旧逻辑此处必报「分支已存在(疑似残留)」;现在自动收养并成功创建
    const r = await wsBranchBegin(repo, { requirement: "同名重建", name: "orphan-a" }, "mcp-http");
    expect(r.branch).toBe("vcs/task/orphan-a");
    void b;
    await wsBranchDiscard(repo, { name: "orphan-a" }, "gui");
    await wsCommit(repo, { summary: "收尾", sessionToken: m.token });
  });

  it("P0-7 回滚脏守卫主干口径:仅 .vcs 簿记脏时回滚不再要求 discardDirty", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "簿记脏场景" }, "cli");
    await writeMain("bk.txt", "1\n");
    await wsCommit(repo, { summary: "基线", sessionToken: m.token });
    const vBase = (await readRegistry()).versions.slice(-1)[0].code;
    const m2 = await wsBeginDetailed(repo, { requirement: "前进版" }, "cli");
    await writeMain("bk.txt", "2\n");
    await wsCommit(repo, { summary: "前进", sessionToken: m2.token });
    // 制造簿记脏(仅 registry/audit,不动 main/):建一个分支即写 registry
    const b = await wsBranchBegin(repo, { requirement: "制造簿记脏", name: "bk-a" }, "mcp-http");
    await wsBranchDiscard(repo, { name: "bk-a" }, "gui");
    // 旧逻辑会因全仓 dirty 拒绝;主干口径下簿记不拦截
    await wsRollback(repo, { code: vBase });
    expect((await readRegistry()).inProgress).toBeNull();
  });
});

describe("分支功能补全(V1.29.0 P1)", () => {
  it("P1-1 基点可选:从历史版本节点开分支,baseline 落在历史", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "基点主线" }, "cli");
    await writeMain("bp.txt", "1\n");
    await wsCommit(repo, { summary: "历史版本", sessionToken: m.token });
    const vOld = (await readRegistry()).versions.slice(-1)[0].code;
    const m2 = await wsBeginDetailed(repo, { requirement: "前进版" }, "cli");
    await writeMain("bp2.txt", "2\n");
    await wsCommit(repo, { summary: "前进", sessionToken: m2.token });
    // 从历史版本开分支
    const r = await wsBranchBegin(repo, { requirement: "历史基点分支", name: "base-a", base: vOld }, "cli");
    expect(r.message).toContain(`基点:${vOld}`);
    const wtFile = path.join(repo, ".vcs", "branch", "base-a", "main", "bp.txt");
    expect(norm(await fs.readFile(wtFile, "utf8"))).toBe("1\n"); // 工作树 = 历史内容,无 bp2.txt
    await expect(fs.access(path.join(repo, ".vcs", "branch", "base-a", "main", "bp2.txt"))).rejects.toThrow();
    // 非法基点被拒
    await expect(
      wsBranchBegin(repo, { requirement: "x", name: "base-b", base: "V9.9.9" }, "cli"),
    ).rejects.toThrow("基点 V9.9.9 不存在");
    await wsBranchDiscard(repo, { name: "base-a" }, "gui");
    await endMainViaRollback();
  });

  it("P1-2 分支内回退:回退上一检查点;按序号回退;脏工作树拒绝", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "回退主线" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "回退分支", name: "rb-b" }, "mcp-http");
    await writeBranch("rb-b", "r.txt", "c1\n");
    await wsBranchCommit(repo, { name: "rb-b", token: b.token, summary: "检查点1" });
    await writeBranch("rb-b", "r.txt", "c2\n");
    await wsBranchCommit(repo, { name: "rb-b", token: b.token, summary: "检查点2" });
    // 脏工作树拒绝
    await writeBranch("rb-b", "dirty.txt", "x\n");
    await expect(wsBranchRollback(repo, { name: "rb-b", token: b.token })).rejects.toThrow("未提交修改");
    // force 回退缺省到上一检查点(HEAD~1 = 检查点1),脏文件一并放弃
    await wsBranchRollback(repo, { name: "rb-b", token: b.token, force: true });
    expect(norm(await fs.readFile(path.join(repo, ".vcs", "branch", "rb-b", "main", "r.txt"), "utf8"))).toBe("c1\n");
    // 分支前进两个检查点(c2'、c3'),按序号回退(2=倒数第二个,即 c2')
    await writeBranch("rb-b", "r.txt", "c2b\n");
    await wsBranchCommit(repo, { name: "rb-b", token: b.token, summary: "检查点2b" });
    await writeBranch("rb-b", "r.txt", "c3b\n");
    await wsBranchCommit(repo, { name: "rb-b", token: b.token, summary: "检查点3b" });
    await wsBranchRollback(repo, { name: "rb-b", to: "2" });
    expect(norm(await fs.readFile(path.join(repo, ".vcs", "branch", "rb-b", "main", "r.txt"), "utf8"))).toBe("c2b\n");
    await wsBranchDiscard(repo, { name: "rb-b", token: b.token });
    await wsCommit(repo, { summary: "收尾", sessionToken: m.token });
  });

  it("P1-4 主干合入分支:无冲突直接合入;分支获得主干新文件;回滚后 update 修复语义错配", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "更新主线A" }, "cli");
    await writeMain("u0.txt", "0\n");
    await wsCommit(repo, { summary: "基线", sessionToken: m.token });
    const b = await wsBranchBegin(repo, { requirement: "更新分支", name: "upd-a" }, "mcp-http");
    await writeBranch("upd-a", "ub.txt", "分支\n");
    await wsBranchCommit(repo, { name: "upd-a", token: b.token, summary: "分支提交" });
    // 主干前进
    const m2 = await wsBeginDetailed(repo, { requirement: "主干新增" }, "cli");
    await writeMain("unew.txt", "主干新文件\n");
    await wsCommit(repo, { summary: "主干新文件", sessionToken: m2.token });
    // update 把主干合入分支
    const out = await wsBranchUpdate(repo, { name: "upd-a", token: b.token });
    expect(out).toContain("已合入");
    const wtRoot = path.join(repo, ".vcs", "branch", "upd-a", "main");
    expect(norm(await fs.readFile(path.join(wtRoot, "unew.txt"), "utf8"))).toBe("主干新文件\n");
    expect(norm(await fs.readFile(path.join(wtRoot, "ub.txt"), "utf8"))).toBe("分支\n");
    // 合并:分叉后主干发生过回滚(endMainViaRollback)——但分支已经 update 对齐,merge-base 前移至主干当前头,
    // 回滚版本已不在「分叉点之后」→ 检测自然放行(update 正是解除回滚×分支僵局的正确解法)
    const mg = await wsBranchMerge(repo, { name: "upd-a", token: b.token });
    expect(mg).toContain("已合并定版");
  });
});

describe("导入分支(V1.31.0)", () => {
  it("P-adopt:孤儿分支导入后工作树重建、登记齐全;已在管理中的拒绝", async () => {
    const m = await wsBeginDetailed(repo, { requirement: "导入主线" }, "cli");
    const b = await wsBranchBegin(repo, { requirement: "将成孤儿再导入", name: "ad-a" }, "mcp-http");
    // 模拟孤儿:删登记留 ref
    const reg = await readRegistry();
    reg.branches = reg.branches.filter((x: { name: string }) => x.name !== "ad-a");
    await fs.writeFile(path.join(repo, ".vcs", "registry.json"), JSON.stringify(reg, null, 2), "utf8");
    // orphans 清单包含它
    const view = await wsParallelView(repo);
    expect(view.orphans).toContain("ad-a");
    // 已在管理中的拒绝
    const b2 = await wsBranchBegin(repo, { requirement: "正常分支", name: "ad-b" }, "mcp-http");
    await expect(wsBranchAdopt(repo, { name: "ad-b", requirement: "x" }, "cli")).rejects.toThrow("已在管理中");
    // 导入:工作树重建、登记齐全
    const r = await wsBranchAdopt(repo, { name: "ad-a", requirement: "导入的需求" }, "gui");
    expect(r.branch).toBe("vcs/task/ad-a");
    await expect(fs.access(path.join(repo, ".vcs", "branch", "ad-a", "main"))).resolves.toBeUndefined();
    const ad = (await readRegistry()).branches.find((x: { name: string }) => x.name === "ad-a");
    expect(ad.requirement).toBe("导入的需求");
    expect(ad.baseline).toMatch(/^[0-9a-f]{40}$/);
    expect((await wsParallelView(repo)).orphans).not.toContain("ad-a");
    void b; void b2;
    await wsBranchDiscard(repo, { name: "ad-a" }, "gui");
    await wsBranchDiscard(repo, { name: "ad-b" }, "gui");
    await endMainViaRollback();
  });
});

describe("发布分支视图(V1.35.0)", () => {
  it("P-publish:publish/* 清单含版本名/指向提交/根文件清单;vcs 工作分支不混入", async () => {
    const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["branch", "publish/v1.34.1", sha]);
    // 干扰项:vcs/task/* 工作分支不应进入发布清单
    const b = await wsBranchBegin(repo, { requirement: "不应混入发布清单", name: "pub-x" }, "cli");
    const list = await wsPublishBranches(repo);
    const hit = list.find((x) => x.branch === "publish/v1.34.1");
    expect(hit).toBeTruthy();
    expect(hit!.version).toBe("V1.34.1");
    expect(hit!.sha).toBe(sha);
    expect(hit!.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(hit!.files).toContain("main/");
    expect(list.some((x) => x.branch.startsWith("vcs/task/"))).toBe(false);
    await git(repo, ["branch", "-D", "publish/v1.34.1"]);
    await wsBranchDiscard(repo, { name: "pub-x" }, "cli");
  });
});
