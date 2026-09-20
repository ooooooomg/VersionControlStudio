import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, tagList } from "../src/git.js";
import { wsBeginDetailed, wsCommit, wsInit, wsStatus, WS_WRITE_LOCK } from "../src/workspace.js";

const pexec = promisify(execFile);
let repo = "";

const write = async (rel: string, c: string) => {
  const p = path.join(repo, rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

/** CLI 子进程(独立进程 = 真跨进程);dist 缺失/过期时先构建 */
const cli = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const cliPath = path.resolve(import.meta.dirname, "../dist/cli.js");
  try {
    return await pexec(process.execPath, [cliPath, ...args], { cwd: repo });
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const e2 = new Error(e.stderr || e.message || String(err)) as Error & { code?: number | string };
    e2.code = e.code;
    throw e2;
  }
};

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "race-test-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
  // 子进程用例跑的是编译产物:每次强制重建,保证 dist 与 src 一致
  await pexec(
    process.execPath,
    [path.resolve(import.meta.dirname, "../node_modules/typescript/bin/tsc"), "-p", path.resolve(import.meta.dirname, "..")],
    { cwd: path.resolve(import.meta.dirname, "..") },
  );
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("并发写竞态(仓库级串行锁)", () => {
  it("并发 vcs_begin 恰有一个成功,胜者需求完整保留", async () => {
    await wsInit(repo, { title: "竞态测试" });
    const rs = await Promise.allSettled([
      wsBeginDetailed(repo, { requirement: "客户端A的需求" }),
      wsBeginDetailed(repo, { requirement: "客户端B的需求" }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "rejected")).toHaveLength(1);
    const reg = JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8"));
    expect(reg.inProgress).not.toBeNull();
    expect(["客户端A的需求", "客户端B的需求"]).toContain(reg.inProgress.requirement);
    const winner = rs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ token: string }>;
    await wsCommit(repo, { summary: "收尾并发 begin", sessionToken: winner.value.token });
  });

  it("并发 vcs_commit 恰有一个成功,注册表与 tag 严格一致,无孤儿记录", async () => {
    await write("main/doc.txt", "v1\n");
    const t0 = (await wsBeginDetailed(repo, { requirement: "基线" })).token;
    await wsCommit(repo, { summary: "V1.1.0 基线", sessionToken: t0 });

    const t1 = (await wsBeginDetailed(repo, { requirement: "准备并发提交" })).token;
    await write("main/a.txt", "A\n");
    const results = await Promise.all([
      wsCommit(repo, { summary: "改动A", sessionToken: t1 }).catch((e: Error) => `FAIL: ${e.message}`),
      new Promise((res) => setTimeout(res, 20)).then(async () => {
        await write("main/b.txt", "B\n");
        return wsCommit(repo, { summary: "改动B", sessionToken: t1 }).catch((e: Error) => `FAIL: ${e.message}`);
      }),
    ]);
    const successes = results.filter((r) => typeof r === "string" && !r.startsWith("FAIL: "));
    expect(successes).toHaveLength(1);

    const reg = JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8"));
    const codes = reg.versions.map((v: { code: string }) => v.code);
    expect(codes).toEqual(["V1.0.0", "V1.1.0", "V1.2.0"]);
    expect(reg.inProgress).toBeNull();

    const tags = await tagList(repo);
    expect(new Set(tags)).toEqual(new Set(codes));

    // 注册表/版本文件夹不允许残留未提交状态(用户自己的 main/b.txt 改动除外)
    const st = await git(repo, ["status", "--porcelain", "-z", "--", "."]);
    const paths = st.split("\0").filter((c) => c.length > 3).map((c) => c.slice(3));
    expect(paths.filter((p) => !p.startsWith("main/"))).toEqual([]);
  });

  it("未登记提交检测:绕过流程的直接 git 提交被 wsStatus 标记", async () => {
    await write("main/direct.txt", "直接提交\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "chore: 绕过流程的直接提交"]);
    const st = await wsStatus(repo);
    expect(st).toContain("未登记提交:1 个");
  });
});

describe("跨进程写锁(write.lock,真双进程)", () => {
  it("两个进程并发 begin 恰有一个成功,失败方得到接管引导文案", async () => {
    const rs = await Promise.allSettled([
      cli(["begin", "--dir", repo, "--requirement", "进程A的需求"]),
      cli(["begin", "--dir", repo, "--requirement", "进程B的需求"]),
    ]);
    const fulfilled = rs.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toContain("正在进行");
    expect(String(rejected[0]!.reason)).toContain("takeover");
    // 清理:胜者收尾(令牌在胜者 stdout 里)
    const out = (fulfilled[0] as PromiseFulfilledResult<{ stdout: string }>).value.stdout;
    const token = /会话令牌:([0-9a-f]{12})/.exec(out)?.[1];
    expect(token).toBeTruthy();
    await wsCommit(repo, { summary: "收尾双进程 begin", sessionToken: token });
  });

  it("两个进程并发 commit 恰有一个成功,注册表与 tag 一致", async () => {
    const t = (await wsBeginDetailed(repo, { requirement: "双进程提交" })).token;
    await write("main/p1.txt", "P1\n");
    await write("main/p2.txt", "P2\n");
    const rs = await Promise.allSettled([
      cli(["commit", "--dir", repo, "--summary", "进程甲提交", "--token", t]),
      cli(["commit", "--dir", repo, "--summary", "进程乙提交", "--token", t]),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reg = JSON.parse(await fs.readFile(path.join(repo, ".vcs", "registry.json"), "utf8"));
    const codes = reg.versions.map((v: { code: string }) => v.code);
    expect(reg.inProgress).toBeNull();
    const tags = await tagList(repo);
    expect(new Set(tags)).toEqual(new Set(codes));
    expect(codes[codes.length - 1]).toBe("V1.4.0");
  });

  it("持锁进程崩溃残留:pid 已死的锁被接管,写操作照常进行", async () => {
    // 造一个持有者已退出的死锁文件
    const holder = await pexec(process.execPath, [
      "-e",
      `const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,source:"dead-proc",acquiredAt:new Date().toISOString()}))`,
      path.join(repo, WS_WRITE_LOCK),
    ]);
    void holder;
    const out = await cli(["begin", "--dir", repo, "--requirement", "死锁接管后开始"]);
    expect(out.stdout).toContain("会话令牌");
    const token = /会话令牌:([0-9a-f]{12})/.exec(out.stdout)?.[1]!;
    await wsCommit(repo, { summary: "死锁接管后收尾", sessionToken: token });
    // 正常释放后锁文件不残留
    await expect(fs.access(path.join(repo, WS_WRITE_LOCK))).rejects.toThrow();
  });

  it("活进程持锁:写操作等待超时后明确报错而非互踩", async () => {
    // 子进程持锁 30s(写合法持有者信息,pid 存活):我们在它持锁期间发起写操作
    const child = execFile(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,source:"live-holder",acquiredAt:new Date().toISOString()}));setTimeout(()=>fs.rmSync(process.argv[1],{force:true}),30000)`,
        path.join(repo, WS_WRITE_LOCK),
      ],
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 300)); // 等子进程建好锁
      await expect(
        wsBeginDetailed(repo, { requirement: "不应成功" }),
      ).rejects.toThrow("另一进程正在写入");
    } finally {
      child.kill();
      await fs.rm(path.join(repo, WS_WRITE_LOCK), { force: true });
    }
  }, 30_000);
});

describe("跨项目并行(多工作区互不干扰)", () => {
  const regTail = async (rp: string) => {
    const reg = JSON.parse(await fs.readFile(path.join(rp, ".vcs", "registry.json"), "utf8"));
    return { inProgress: reg.inProgress, count: reg.versions.length, latest: reg.versions[reg.versions.length - 1]?.code };
  };

  it("同进程:双仓并行 begin/commit 各自成功,登记簿互不串扰", async () => {
    const repoB = await fs.mkdtemp(path.join(os.tmpdir(), "race-test-b-"));
    try {
      await wsInit(repoB, { title: "并发B仓" });
      const beforeA = await regTail(repo);
      const beforeB = await regTail(repoB);
      const [ta, tb] = await Promise.all([
        wsBeginDetailed(repo, { requirement: "A仓任务" }, "cli"),
        wsBeginDetailed(repoB, { requirement: "B仓任务" }, "cli"),
      ]);
      expect(ta.token).not.toBe(tb.token);
      await write("main/x.txt", "A仓\n");
      await fs.writeFile(path.join(repoB, "main", "y.txt"), "B仓\n", "utf8");
      await Promise.all([
        wsCommit(repo, { summary: "A仓收尾", source: "cli", sessionToken: ta.token }),
        wsCommit(repoB, { summary: "B仓收尾", source: "cli", sessionToken: tb.token }),
      ]);
      const afterA = await regTail(repo);
      const afterB = await regTail(repoB);
      expect(afterA.count).toBe(beforeA.count + 1);
      expect(afterB.count).toBe(beforeB.count + 1);
      expect(afterA.inProgress).toBeNull();
      expect(afterB.inProgress).toBeNull();
    } finally {
      await fs.rm(repoB, { recursive: true, force: true });
    }
  });

  it("跨进程:双仓 CLI 并行 begin 均成功且令牌互异", async () => {
    const repoB = await fs.mkdtemp(path.join(os.tmpdir(), "race-test-c-"));
    try {
      await wsInit(repoB, { title: "并发C仓" });
      const rs = await Promise.allSettled([
        cli(["begin", "--dir", repo, "--requirement", "进程A在A仓"]),
        cli(["begin", "--dir", repoB, "--requirement", "进程B在B仓"]),
      ]);
      expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const tokens = rs.map(
        (r) => /会话令牌:([0-9a-f]{12})/.exec((r as PromiseFulfilledResult<{ stdout: string }>).value.stdout)?.[1] ?? "",
      );
      expect(tokens[0]).toBeTruthy();
      expect(tokens[1]).toBeTruthy();
      expect(tokens[0]).not.toBe(tokens[1]);
      await wsCommit(repo, { summary: "收尾A仓跨进程", source: "cli", sessionToken: tokens[0] });
      await wsCommit(repoB, { summary: "收尾B仓跨进程", source: "cli", sessionToken: tokens[1] });
    } finally {
      await fs.rm(repoB, { recursive: true, force: true });
    }
  }, 30_000);
});
