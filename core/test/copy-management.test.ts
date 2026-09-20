import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  wsBeginDetailed,
  wsCommit,
  wsDeleteCopy,
  wsInit,
  wsListVersions,
  wsReadDoc,
  wsRestoreCopy,
  wsRollback,
  wsStatus,
} from "../src/workspace.js";

let repo = "";

const write = async (rel: string, c: string) => {
  const p = path.join(repo, rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

/** begin 并返回会话令牌(commit 所有权校验用) */
const beginToken = async (requirement: string): Promise<string> => {
  const r = await wsBeginDetailed(repo, { requirement }, "cli");
  return r.token;
};

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "ws-copy-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("回滚副本管理(删除 / 恢复)", () => {
  it("回滚物化副本 → 删除(历史不动,无误报)→ 恢复(内容与 tag 一致)", async () => {
    await wsInit(repo, { title: "副本管理测试" }, "cli");
    const t1 = await beginToken("初始版本");
    await write("main/a.txt", "v1\n");
    await wsCommit(repo, { summary: "v1", sessionToken: t1, source: "cli" });
    const t2 = await beginToken("第二版");
    await write("main/a.txt", "v2\n");
    await write("main/b.txt", "新增\n");
    await wsCommit(repo, { summary: "v2", sessionToken: t2, source: "cli" });

    // 回滚到 V1.0.0:副本物化,main/ 变为 v1 内容
    const rb = await wsRollback(repo, { code: "V1.0.0", discardDirty: true, source: "cli" });
    expect(rb).toContain("已回滚");
    expect(await fs.readFile(path.join(repo, "main", "a.txt"), "utf8")).toBe("v1\n");
    let list = await wsListVersions(repo);
    expect(list.find((v) => v.code === "V1.0.0")!.hasCopy).toBe(true);
    expect(await fs.readFile(path.join(repo, "V1.0.0", "项目副本", "a.txt"), "utf8")).toBe("v1\n");

    // 删除副本:磁盘目录消失、hasCopy 翻转、产生副本管理提交;main/ 与 tag 不动
    const del = await wsDeleteCopy(repo, "V1.0.0", "cli");
    expect(del).toContain("已删除");
    list = await wsListVersions(repo);
    expect(list.find((v) => v.code === "V1.0.0")!.hasCopy).toBe(false);
    expect(list.find((v) => v.code === "V1.0.0")!.materialized).toBe(true);
    await expect(fs.access(path.join(repo, "V1.0.0", "项目副本"))).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, "main", "a.txt"), "utf8")).toBe("v1\n");
    expect(await git(repo, ["show", "V1.0.0:main/a.txt"])).toBe("v1\n");
    // 副本管理提交只动 V 文件夹,不触发"未登记提交"误报
    expect(await wsStatus(repo)).not.toContain("未登记提交");

    // 恢复副本:内容重新取自版本历史
    const res = await wsRestoreCopy(repo, "V1.0.0", "cli");
    expect(res).toContain("已生成");
    expect(await fs.readFile(path.join(repo, "V1.0.0", "项目副本", "a.txt"), "utf8")).toBe("v1\n");
    await expect(fs.access(path.join(repo, "V1.0.0", "项目副本", "b.txt"))).rejects.toThrow();
  });

  it("守卫:无副本不可删、任意版本可生成副本、已有副本不可重复生成", async () => {
    await expect(wsDeleteCopy(repo, "V1.1.0", "cli")).rejects.toThrow("没有物化的项目副本");
    // 放开限制后:非回滚目标的版本也能直接生成副本(main/ 不动)
    const rs = await wsRestoreCopy(repo, "V1.1.0", "cli");
    expect(rs).toContain("已生成");
    expect(await fs.readFile(path.join(repo, "V1.1.0", "项目副本", "a.txt"), "utf8")).toBe("v2\n");
    expect(await wsStatus(repo)).not.toContain("未登记提交");
    await expect(wsRestoreCopy(repo, "V1.1.0", "cli")).rejects.toThrow("已有项目副本");
    await expect(wsRestoreCopy(repo, "V9.9.9", "cli")).rejects.toThrow("不存在");
  });
});

describe("vcs_commit 的 exclude(版本外排除)", () => {
  it("排除路径不入本版本、原样留在工作区;下次提交可正常收编", async () => {
    const t = await beginToken("功能A");
    await write("main/a.txt", "v1-功能A\n"); // 已跟踪文件的修改 → 会进 diffstat
    await write("main/wip.txt", "无关半成品\n"); // 无关半成品 → 排除
    const out = await wsCommit(repo, {
      summary: "功能A",
      sessionToken: t,
      exclude: ["main/wip.txt"],
      source: "cli",
    });
    expect(out).toContain("已按 exclude 排除 1 个路径");
    // 版本内容:含 a.txt 修改,不含 wip.txt
    const committed = await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(committed).toContain("main/a.txt");
    expect(committed).not.toContain("main/wip.txt");
    // 改动日志为新分点格式:无「## 摘要」标题、无变更文件统计节,内容只有摘要分点
    const list = await wsListVersions(repo);
    const changes = await wsReadDoc(repo, list[list.length - 1]!.code, "changes");
    expect(changes).toContain("功能A");
    expect(changes).not.toContain("## 摘要");
    expect(changes).not.toContain("变更文件统计");
    expect(changes).not.toContain("wip.txt");
    // 排除文件原样留在工作区,且保持未暂存
    expect(await fs.readFile(path.join(repo, "main", "wip.txt"), "utf8")).toBe("无关半成品\n");
    const status = (await git(repo, ["status", "--porcelain", "--", "main/wip.txt"])).trim();
    expect(status.startsWith("??")).toBe(true);

    // 下一次不带 exclude 的提交把半成品正常收编
    const t2 = await beginToken("收编半成品");
    await write("main/a.txt", "v1-收编\n");
    await wsCommit(repo, { summary: "收编半成品", sessionToken: t2, source: "cli" });
    const committed2 = await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(committed2).toContain("main/wip.txt");
  });

  it("排除后 main/ 一无所剩:拒绝空版本", async () => {
    const t = await beginToken("只改了将被排除的文件");
    await write("main/only-excluded.txt", "x\n");
    await expect(
      wsCommit(repo, {
        summary: "s",
        sessionToken: t,
        exclude: ["main/only-excluded.txt"],
        source: "cli",
      }),
    ).rejects.toThrow("拒绝生成空版本");
  });
});
