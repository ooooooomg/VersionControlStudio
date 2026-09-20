import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: "inline", logLevel: "silent" };

await Promise.all([
  // 主进程:ESM;核心包运行时从 node_modules 解析(单一事实源,不打包)
  build({
    ...common,
    entryPoints: ["src/main/index.ts"],
    platform: "node",
    format: "esm",
    outfile: "dist/main/index.js",
    external: ["electron", "electron-updater", "versioncontrol-mcp", "@modelcontextprotocol/sdk", "zod"],
  }),
  // stdio 桥:独立入口,CJS,供只支持 stdio 的 AI 客户端作为 command
  build({
    ...common,
    entryPoints: ["src/main/stdio-bridge.ts"],
    platform: "node",
    format: "esm",
    outfile: "dist/main/stdio-bridge.mjs",
    external: ["versioncontrol-mcp"],
  }),
  // 预加载脚本:sandbox 环境要求 CJS
  build({
    ...common,
    entryPoints: ["src/preload/index.ts"],
    platform: "node",
    format: "cjs",
    outfile: "dist/main/preload.cjs",
    external: ["electron"],
  }),
  // 渲染端:浏览器 ESM
  build({
    ...common,
    entryPoints: ["src/renderer/index.tsx"],
    format: "esm",
    jsx: "automatic",
    outfile: "dist/renderer/index.js",
  }),
]);

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/styles.css", "dist/renderer/styles.css");
console.log("build ok");
