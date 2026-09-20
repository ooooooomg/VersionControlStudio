import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  wsBeginDetailed,
  wsCommit,
  wsInit,
  wsListVersions,
  wsMigrateLegacy,
  wsOffenders,
  wsReadDoc,
  wsRollback,
  wsStatus,
} from "../src/workspace.js";

let repo = "";

const write = async (rel: string, c: string, root = repo) => {
  const p = path.join(root, rel.replaceAll("/", path.sep));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
};

/** begin 并返回会话令牌(commit 所有权校验用) */
const beginToken = async (requirement: string): Promise<string> => {
  const r = await wsBeginDetailed(repo, { requirement }, "cli");
  return r.token;
};

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("工作区模型 v3", () => {
  it("init:生成 main/工作区日志/.vcs 三类结构", async () => {
    const out = await wsInit(repo, { title: "通用项目A" }, "cli");
    expect(out).toContain("工作区已创建");
    await expect(wsInit(repo, { title: "x" })).rejects.toThrow("已是工作区");
    const st = await wsStatus(repo);
    expect(st).toContain("通用项目A");
  });

  it("begin 记录需求;越界文件导致 commit 被拒;移入 main 后 V0.0.0 定版", async () => {
    const token = await beginToken("搭建项目骨架");
    await write("README.md", "越界!根目录不允许");
    await expect(
      wsCommit(repo, { summary: "s", sessionToken: token }),
    ).rejects.toThrow("越界");
    expect((await wsOffenders(repo))).toContain("README.md");
    await write("main/README.md", "项目说明");
    await fs.rm(path.join(repo, "README.md"));
    const out = await wsCommit(repo, { summary: "初始化骨架", bump: "content", sessionToken: token });
    expect(out).toContain("V1.0.0");
    expect(await git(repo, ["tag"])).toContain("V1.0.0");
    expect(await wsReadDoc(repo, "V1.0.0", "purpose")).toContain("搭建项目骨架");
    expect(await wsReadDoc(repo, "V1.0.0", "changes")).toContain("初始化骨架");
  });

  it("微调 Z+1;里程碑 X+1;提交方式按 source", async () => {
    const t1 = await beginToken("修正错别字");
    await write("main/README.md", "项目说明(修正)");
    await wsCommit(repo, { summary: "修正错别字", bump: "polish", source: "gui", sessionToken: t1 });
    const list = await wsListVersions(repo);
    expect(list[list.length - 1]!.code).toBe("V1.0.1");
    const t2 = await beginToken("重大重构");
    await write("main/src/app.py", "print('v2')");
    await wsCommit(repo, { summary: "重构架构", bump: "major", source: "cli", sessionToken: t2 });
    const list2 = await wsListVersions(repo);
    expect(list2[list2.length - 1]!.code).toBe("V2.0.0");
  });

  it("rollback:main 精确还原 + 副本物化到 V 文件夹 + 新版本登记", async () => {
    await write("main/src/app.py", "print('v3 broken')");
    await expect(
      wsRollback(repo, { code: "V1.0.0", discardDirty: true }),
    ).resolves.toContain("已回滚");
    const content = await fs.readFile(path.join(repo, "main", "README.md"), "utf8");
    expect(content).toContain("项目说明");
    // 副本物化:V0.0.0/项目副本/ 含当时文件;其后新增的 src/app.py 不在副本中
    const copyReadme = await fs.readFile(
      path.join(repo, "V1.0.0", "项目副本", "README.md"),
      "utf8",
    );
    expect(copyReadme).toContain("项目说明");
    await expect(
      fs.access(path.join(repo, "V1.0.0", "项目副本", "src", "app.py")),
    ).rejects.toThrow();
    const list = await wsListVersions(repo);
    expect(list[list.length - 1]!.purpose).toContain("回滚到 V1.0.0");
    expect(list.find((v) => v.code === "V1.0.0")!.materialized).toBe(true);
  });
});

describe("迁移旧库", () => {
  it("旧 paper_versions 库 → 新工作区(main + V 存档 + 原编号标注)", async () => {
    // 造一个旧模型库
    const oldRepo = await fs.mkdtemp(path.join(os.tmpdir(), "ws-old-"));
    try {
      await git(oldRepo, ["init", "-b", "master"]);
      await git(oldRepo, ["config", "user.email", "t@t"]);
      await git(oldRepo, ["config", "user.name", "T"]);
      const w = async (rel: string, c: string) => {
        await fs.mkdir(path.dirname(path.join(oldRepo, rel)), { recursive: true });
        await fs.writeFile(path.join(oldRepo, rel), c, "utf8");
      };
      await w("draft/a.tex", "old paper\n");
      await w("paper_versions/paper-version.json", JSON.stringify({
        title: "旧论文",
        versions: [
          { code: "CN0.0.0", summary: "中文初稿", date: "2026-01-01", note: "第一版" },
          { code: "TEX1.0.0", summary: "投稿版", date: "2026-02-01" },
        ],
        paths: { cn: ["draft"] },
      }));
      await w("paper_versions/changelogs/CN0.0.0.md", "# CN0.0.0\n旧日志内容");
      await git(oldRepo, ["add", "-A"]);
      await git(oldRepo, ["commit", "-m", "old final"]);

      const newRepo = await fs.mkdtemp(path.join(os.tmpdir(), "ws-mig-"));
      try {
        const out = await wsMigrateLegacy(newRepo, {
          title: "迁移论文",
          oldRepo,
        });
        expect(out).toContain("迁移完成");
        const main = await fs.readFile(path.join(newRepo, "main", "draft", "a.tex"), "utf8");
        expect(main).toBe("old paper\n");
        const purpose = await fs.readFile(
          path.join(newRepo, "V0.1.0", "更新目的.md"),
          "utf8",
        );
        expect(purpose).toContain("第一版");
        expect(purpose).toContain("CN0.0.0");
        const changes = await fs.readFile(
          path.join(newRepo, "V0.1.0", "改动日志.md"),
          "utf8",
        );
        expect(changes).toContain("旧日志内容");
        const st = await wsStatus(newRepo);
        expect(st).toContain("迁移论文");
        expect(st).toContain("V1.1.0");
      } finally {
        await fs.rm(newRepo, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(oldRepo, { recursive: true, force: true });
    }
  });
});
