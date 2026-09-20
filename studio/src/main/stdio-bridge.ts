/**
 * stdio 兼容桥 —— 供只支持 stdio 的 AI 客户端(Claude Desktop 等)作为 command 使用。
 * 即核心 versioncontrol-mcp 的 stdio server 本体(同一份工具与审计),独立于 GUI 进程运行。
 * 客户端 initialize 握手时记录连接标识(设置页展示"谁连接了本服务")。
 * 统一接口多工具:env PVC_CLIENT=<接入名> 声明工具身份 → 按路由表(同一份设置文件)
 * 注入默认项目/权限/越界档,与 HTTP 子路径接入同机制。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "versioncontrol-mcp/dist/index.js";
import { loadSettings } from "./settings.js";
import { recordConnection } from "./mcp-connections.js";

const settings = await loadSettings();
const client = process.env.PVC_CLIENT?.trim() || undefined;
const route = client ? settings.clientRoutes?.[client] : undefined;

const server = createServer("mcp-stdio", {
  client,
  defaultRepo: route?.repoPath || undefined,
  permission: route?.permission ?? ((process.env.PVC_PERMISSION ?? "").trim().toLowerCase() === "readonly" ? "readonly" : "auto"),
  strict: route?.strict ?? false,
});
server.server.oninitialized = () => {
  const ci = server.server.getClientVersion();
  void recordConnection("stdio", client ? `${client}(${ci?.name ?? "?"})` : ci?.name, ci?.version).catch(() => {});
};

server
  .connect(new StdioServerTransport())
  .then(() => process.stderr.write(`[studio-stdio-bridge] MCP server running on stdio${client ? `(client=${client})` : ""}\n`))
  .catch((err: unknown) => {
    process.stderr.write(`[studio-stdio-bridge] fatal: ${err}\n`);
    process.exit(1);
  });

// 生命周期:客户端关闭时必须让本进程有限时内终结,否则客户端的优雅关闭会一直等子进程。
// SDK 的 StdioServerTransport 不监听 stdin 的 end/close,EOF 对其不可见,须自行处理;
// 在途调用可能卡在跨进程写锁等待或 stdout drain 上,不能依赖事件循环自然清空。
const SHUTDOWN_GRACE_MS = 3000;
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void server.close().catch(() => {});
  // 宽限期内在途调用自然完成则随事件循环清空退出;超时强制退出。不写 stderr(管道可能已无人读)。
  const force = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  force.unref?.();
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
