/**
 * 把运行入口打包成自包含单文件(esbuild bundle,覆盖 tsc 输出的同名文件):
 * 插件市场安装(${CLAUDE_PLUGIN_ROOT})与 .mcpb 都不执行 npm install,
 * dist/index.js 与 dist/cli.js 必须零依赖、node 直接可跑。
 * 类型产物(dist/*.d.ts)与其余 tsc 输出不受影响;test/race.test.ts 会实际调起打包后的 cli.js。
 */
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", logLevel: "silent" };

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
// 入口文件自带 shebang,esbuild 打包时会原样保留(不要再加 banner,否则出现两行 shebang)
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" });
console.log("bundle ok");
