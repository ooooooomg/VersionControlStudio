import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  wsBeginDetailed,
  wsCommit,
  wsInit,
  wsInProgressView,
  wsRollback,
  wsStatus,
  wsTouch,
  type WsRegistry,
} from "../src/workspace.js";

let repo = "";

const write = async (rel: string, c: string) => {
  const p = path.join(repo, rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

const readRegistry = async (): Promise<WsRegistry> =>
  JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8")) as WsRegistry;

const beginToken = async (requirement: string): Promise<string> =>
  (await wsBeginDetailed(repo, { requirement }, "cli")).token;

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "own-test-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("会话所有权与显式接管", () => {
  it("begin 签发 12 位会话令牌并在提示文本中说明用途", async () => {
    await wsInit(repo, { title: "所有权测试" });
    const r = await wsBeginDetailed(repo, { requirement: "第一个需求" }, "cli");
    expect(r.token).toMatch(/^[0-9a-f]{12}$/);
    expect(r.message).toContain("会话令牌");
    expect(r.message).toContain(r.token);
    await wsCommit(repo, { summary: "初始", sessionToken: r.token });
  });

  it("无令牌/错令牌的 commit 被拒,文案引导等待或接管", async () => {
    const token = await beginToken("所有者会话的需求");
    await write("main/a.txt", "A\n");
    await expect(wsCommit(repo, { summary: "无令牌" })).rejects.toThrow("请勿替其他会话收尾");
    await expect(
      wsCommit(repo, { summary: "错令牌", sessionToken: "aaaaaaaaaaaa" }),
    ).rejects.toThrow("正在进行");
    // 持有者本人携带令牌可正常收尾
    await wsCommit(repo, { summary: "本人收尾", sessionToken: token });
  });

  it("心跳:令牌匹配刷新最近活跃,不匹配不刷新", async () => {
    const token = await beginToken("心跳需求");
    // 把活跃时间改旧,便于断言刷新生效
    const reg = await readRegistry();
    reg.inProgress!.lastActiveAt = "2026-01-01 00:00";
    await fs.writeFile(path.join(repo, ".vcs", "registry.json"), JSON.stringify(reg, null, 2), "utf8");
    await expect(wsTouch(repo, "aaaaaaaaaaaa")).resolves.toBe(false);
    expect((await readRegistry()).inProgress!.lastActiveAt).toBe("2026-01-01 00:00");
    await expect(wsTouch(repo, token)).resolves.toBe(true);
    expect((await readRegistry()).inProgress!.lastActiveAt).not.toBe("2026-01-01 00:00");
    const st = await wsStatus(repo);
    expect(st).toContain("最近活跃:2026-");
    await wsCommit(repo, { summary: "收尾心跳", sessionToken: token });
  });

  it("停滞超过 30 分钟:status 标注疑似停滞,结构化视图 stalled=true", async () => {
    const token = await beginToken("停滞需求");
    const reg = await readRegistry();
    reg.inProgress!.lastActiveAt = "2026-01-01 00:00";
    await fs.writeFile(path.join(repo, ".vcs", "registry.json"), JSON.stringify(reg, null, 2), "utf8");
    const st = await wsStatus(repo);
    expect(st).toContain("疑似停滞");
    expect(st).toContain("takeover");
    const view = await wsInProgressView(repo);
    expect(view?.stalled).toBe(true);
    expect(view!.stallMinutes).toBeGreaterThanOrEqual(30);
    await wsCommit(repo, { summary: "收尾停滞", sessionToken: token });
  });

  it("takeover continue:沿用需求/基线/半成品,令牌换发(旧令牌失效)", async () => {
    const oldToken = await beginToken("前任会话的需求");
    await write("main/wip.txt", "half-done\n");
    const before = await readRegistry();
    expect(before.inProgress!.owner).toBe(oldToken);
    const taken = await wsBeginDetailed(repo, { requirement: "", takeover: "continue" }, "mcp-http");
    expect(taken.token).not.toBe(oldToken);
    const reg = await readRegistry();
    expect(reg.inProgress!.requirement).toBe("前任会话的需求");
    expect(reg.inProgress!.baseline).toBe(before.inProgress!.baseline);
    // 旧令牌已被换发:不能再收尾;新令牌连同半成品一起提交成功
    await expect(wsCommit(repo, { summary: "旧令牌", sessionToken: oldToken })).rejects.toThrow("请勿替其他会话收尾");
    await wsCommit(repo, { summary: "接手后收尾", sessionToken: taken.token });
  });

  it("takeover fresh:前任半成品 stash 快照可找回,新需求干净开始", async () => {
    const oldToken = await beginToken("将被重开的需求");
    await write("main/fresh-wip.txt", "stash me\n");
    const taken = await wsBeginDetailed(
      repo,
      { requirement: "全新的需求", takeover: "fresh" },
      "cli",
    );
    // 半成品进了 stash(untracked 文件存于 stash 的第三父提交),可从 stash 恢复
    const stashes = await git(repo, ["stash", "list"]);
    expect(stashes).toContain("vcs-takeover:");
    expect(await git(repo, ["show", "stash@{0}^3:main/fresh-wip.txt"])).toBe("stash me\n");
    await expect(fs.access(path.join(repo, "main", "fresh-wip.txt"))).rejects.toThrow();
    // 新令牌对新需求生效
    await write("main/new.txt", "new\n");
    await wsCommit(repo, { summary: "新需求收尾", sessionToken: taken.token });
    const reg = await readRegistry();
    expect(reg.versions[reg.versions.length - 1]!.purpose).toBe("全新的需求");
  });

  it("没有进行中版本时 takeover 报错引导直接 begin", async () => {
    await expect(
      wsBeginDetailed(repo, { requirement: "x", takeover: "continue" }, "cli"),
    ).rejects.toThrow("无需接管");
  });

  it("legacy 进行中版本(旧版登记无令牌):commit 拒绝,接管后可收尾", async () => {
    const reg = await readRegistry();
    reg.inProgress = {
      code: "V1.9.9",
      requirement: "旧版工具留下的进行中版本",
      baseline: reg.versions[reg.versions.length - 1]!.code,
      startedAt: "2026-01-01 00:00",
    };
    await fs.writeFile(path.join(repo, ".vcs", "registry.json"), JSON.stringify(reg, null, 2), "utf8");
    await expect(wsCommit(repo, { summary: "s" })).rejects.toThrow("旧版工具登记");
    const taken = await wsBeginDetailed(repo, { requirement: "", takeover: "continue" }, "cli");
    await write("main/legacy.txt", "done\n");
    await wsCommit(repo, { summary: "接管后收尾", sessionToken: taken.token });
  });

  it("rollback 遇进行中版本:默认拒绝,resolveInProgress=stash 半成品可找回", async () => {
    await beginToken("将被 stash 的回滚需求");
    await write("main/rb-wip.txt", "keep me\n");
    const target = (await readRegistry()).versions[0]!.code;
    await expect(wsRollback(repo, { code: target })).rejects.toThrow("resolveInProgress");
    await wsRollback(repo, { code: target, resolveInProgress: "stash" });
    const stashes = await git(repo, ["stash", "list"]);
    expect(stashes).toContain("vcs-rollback:");
    expect(await git(repo, ["show", "stash@{0}^3:main/rb-wip.txt"])).toBe("keep me\n");
    const reg = await readRegistry();
    expect(reg.inProgress).toBeNull();
  });
});
