/** 多 AI 工具身份贯通 + 统一接口路由解析(V1.18.0) */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  occupancyOfRegistry,
  wsBeginDetailed,
  wsBranchBegin,
  wsBranchDiscard,
  wsCommit,
  wsInit,
  wsLoadRegistry,
  wsStatus,
  wsTempSave,
  type WsRegistry,
} from "../src/workspace.js";
import { isWriteTool, resolveRepoFor, type ServerContext } from "../src/index.js";

let repo = "";

const write = async (rel: string, c: string) => {
  const p = path.join(repo, rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "identity-test-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
  await wsInit(repo, { title: "身份贯通测试" });
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("工具身份贯通(HTTP 子路径 / stdio env 归因)", () => {
  it("begin 记录工具身份:registry/状态文本/审计三处落 claude", async () => {
    const r = await wsBeginDetailed(repo, { requirement: "身份贯通A" }, { source: "mcp-http", client: "claude" });
    expect(r.token).toBeTruthy();
    const reg = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg.inProgress?.ownerClient).toBe("claude");
    expect(reg.inProgress?.ownerSource).toBe("mcp-http");
    const st = await wsStatus(repo);
    expect(st).toContain("工具 claude");
    const audit = await fs.readFile(path.join(repo, ".vcs", "audit.log"), "utf8");
    expect(audit).toContain("mcp-http:claude | ws_begin");
    await wsCommit(repo, {
      summary: "收尾身份贯通A",
      source: { source: "mcp-http", client: "claude" },
      sessionToken: r.token,
    });
  });

  it("令牌正确但调用工具不同:提交放行,结果附属主对照警告", async () => {
    const r = await wsBeginDetailed(repo, { requirement: "跨工具令牌" }, { source: "mcp-stdio", client: "claude" });
    await write("main/a.txt", "跨工具令牌\n");
    const out = await wsCommit(repo, {
      summary: "异工具持令牌提交",
      source: { source: "mcp-stdio", client: "zcode" },
      sessionToken: r.token,
    });
    expect(out).toContain("令牌属主对照");
    expect(out).toContain("claude");
    expect(out).toContain("zcode");
  });

  it("takeover continue 换发令牌并把属主工具更新为接管方", async () => {
    const r1 = await wsBeginDetailed(repo, { requirement: "接管属主" }, { source: "mcp-http", client: "claude" });
    const r2 = await wsBeginDetailed(
      repo,
      { requirement: "接管属主", takeover: "continue" },
      { source: "mcp-stdio", client: "zcode" },
    );
    expect(r2.token).not.toBe(r1.token);
    const reg = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg.inProgress?.ownerClient).toBe("zcode");
    // 原工具旧令牌已失效
    await expect(
      wsCommit(repo, { summary: "旧令牌收尾", source: "mcp-http", sessionToken: r1.token }),
    ).rejects.toThrow("请勿替其他会话收尾");
    // 新持有者(同工具)提交无警告
    await write("main/b.txt", "接管后收尾\n");
    const out = await wsCommit(repo, {
      summary: "接管后收尾",
      source: { source: "mcp-stdio", client: "zcode" },
      sessionToken: r2.token,
    });
    expect(out).not.toContain("令牌属主对照");
  });

  it("旧版登记(无工具身份)兼容:状态不显示工具段,接管后补齐", async () => {
    const r = await wsBeginDetailed(repo, { requirement: "旧版兼容" }, "mcp-stdio");
    const reg = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg.inProgress?.ownerClient).toBeUndefined();
    const st = await wsStatus(repo);
    expect(st).toContain("来源:mcp-stdio |");
    expect(st).not.toContain("工具 ");
    // 另一会话看到的是"另一会话"提示而非崩溃
    await expect(wsBeginDetailed(repo, { requirement: "他人尝试" })).rejects.toThrow("正在进行");
    await wsBeginDetailed(repo, { requirement: "旧版兼容", takeover: "continue" }, { source: "mcp-http", client: "claude" });
    const reg2 = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg2.inProgress?.ownerClient).toBe("claude");
    void r;
    // 清理进行中,免影响后续用例
    const cur = await wsBeginDetailed(repo, { requirement: "旧版兼容", takeover: "continue" }, "mcp-stdio");
    await write("main/c.txt", "清理\n");
    await wsCommit(repo, { summary: "清理旧版兼容", sessionToken: cur.token });
  });

  it("并行分支与 temp 记录工具身份,占用视图可统计", async () => {
    const holder = await wsBeginDetailed(repo, { requirement: "占用主线的任务" }, { source: "mcp-http", client: "claude" });
    const br = await wsBranchBegin(repo, { requirement: "分支并行任务" }, { source: "mcp-stdio", client: "zcode" });
    expect(br.worktree).not.toBe("(main)");
    let reg = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg.branches?.[0]?.ownerClient).toBe("zcode");
    // 持有者把 main/ 变化转存 temp
    await write("main/dirty.txt", "待保全\n");
    await wsTempSave(repo, { summary: "测试转存", sessionToken: holder.token }, { source: "mcp-http", client: "claude" });
    reg = (await wsLoadRegistry(repo)) as WsRegistry;
    expect(reg.temp?.[0]?.client).toBe("claude");
    // 占用视图(GUI 项目卡片数据源)
    const occ = occupancyOfRegistry(reg);
    expect(occ.branchCount).toBe(1);
    expect(occ.tempCount).toBe(1);
    expect(occ.mergeConflict).toBe(false);
    expect(occ.inProgress).toBeNull(); // 持有者转存 temp 时已放弃任务
    // 空注册表安全
    expect(occupancyOfRegistry(null)).toEqual({ inProgress: null, branchCount: 0, tempCount: 0, mergeConflict: false });
    await wsBranchDiscard(repo, { name: br.worktree.split("/").pop()!, token: br.token }, "mcp-http");
  });
});

describe("统一接口路由解析链 resolveRepoFor", () => {
  const base: ServerContext = { client: "claude", defaultRepo: path.resolve("X:/绑定项目") };
  it("显式参数优先于绑定与环境变量", () => {
    const r = resolveRepoFor("Y:/显式项目", base, { PAPER_VERSION_REPO: "Z:/env项目" });
    expect(r.repo).toBe(path.resolve("Y:/显式项目"));
    expect(r.warn).toContain("路由提醒");
  });
  it("未传参数自动落到路由表绑定项目(不落环境变量)", () => {
    const r = resolveRepoFor(undefined, base, { PAPER_VERSION_REPO: "Z:/env项目" });
    expect(r.repo).toBe(path.resolve("X:/绑定项目"));
    expect(r.warn).toBe("");
  });
  it("无绑定时回退环境变量;全缺报错", () => {
    const r = resolveRepoFor(undefined, { client: "claude" }, { PAPER_VERSION_REPO: "Z:/env项目" });
    expect(r.repo).toBe(path.resolve("Z:/env项目"));
    expect(() => resolveRepoFor(undefined, {}, {})).toThrow("缺少 repoPath");
    // 空白参数等同未提供:回退绑定而非报错
    expect(resolveRepoFor("  ", base, {}).repo).toBe(path.resolve("X:/绑定项目"));
  });
  it("越界:strict=true 直接拒绝,strict=false 放行带警告", () => {
    expect(() => resolveRepoFor("Y:/别的项目", { ...base, strict: true }, {})).toThrow("严格路由");
    const r = resolveRepoFor("Y:/别的项目", base, {});
    expect(r.warn).toContain("已指定项目");
  });
  it("同一项目的不同大小写/斜杠写法不视为越界(Windows)", () => {
    if (process.platform !== "win32") return;
    const bound = path.resolve("X:/绑定项目");
    const r = resolveRepoFor(bound.toLowerCase(), base, {});
    expect(r.warn).toBe("");
  });
  it("readonly 工具清单覆盖全部写工具且不含只读工具", () => {
    for (const t of [
      "vcs_init", "vcs_begin", "vcs_commit", "vcs_rollback",
      "vcs_delete_copy", "vcs_restore_copy", "vcs_migrate",
      "vcs_branch_begin", "vcs_branch_commit", "vcs_branch_merge", "vcs_branch_discard",
      "vcs_temp_save", "vcs_temp_apply", "vcs_temp_discard",
    ]) {
      expect(isWriteTool(t)).toBe(true);
    }
    for (const t of ["vcs_status", "vcs_versions", "vcs_read_doc", "vcs_diff", "vcs_audit", "vcs_branches", "vcs_analyze"]) {
      expect(isWriteTool(t)).toBe(false);
    }
  });
});
