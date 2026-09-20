/**
 * 生成 versioncontrol-mcp.mcpb(Claude Desktop 一键安装包):
 * 1. 暂存目录装生产依赖(sdk+zod),拷入 dist/ 与按 package.json 版本号填充的 manifest.json;
 * 2. 调 mcpb CLI 打包,产物落在本目录。
 * 本地与 CI(release.yml)共用;需要网络下载 mcpb CLI。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const stage = path.join(root, "build", "mcpb-stage");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 生产依赖安装进暂存目录(干净、不含 devDeps 与源码)
cpSync(path.join(root, "package.json"), path.join(stage, "package.json"));
run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], stage);
cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });

// 清单:以 mcpb-manifest.json 为模板,版本号跟随 package.json
const manifest = JSON.parse(readFileSync(path.join(root, "mcpb-manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 打包(mcpb 以暂存目录命名产物,统一改回 <name>-<version>.mcpb)
run("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stage], root);
renameSync(
  path.join(root, "mcpb-stage.mcpb"),
  path.join(root, `${manifest.name}-${manifest.version}.mcpb`),
);

rmSync(path.join(root, "build"), { recursive: true, force: true });
console.log(`mcpb ok: ${manifest.name}-${manifest.version}.mcpb`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败,退出码 ${r.status}`);
  }
}
