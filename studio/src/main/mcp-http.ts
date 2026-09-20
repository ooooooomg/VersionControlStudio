/**
 * 内置 MCP HTTP 端点(Zotero 式"应用即服务"):
 * app 启动即在 127.0.0.1:<port>/mcp 运行 streamable-HTTP MCP 服务,
 * AI 工具配置一个 URL 即可直连本软件;端口占用自动 +1 重试。
 * 统一接口多工具:每个工具用自己的子路径 /mcp/<接入名> 接入 → 服务端按名字归因,
 * 并按 GUI 路由表(设置 → AI 工具连接)注入默认项目/权限/越界档;/mcp 保持兼容(匿名)。
 * 无状态模式按 SDK 推荐做法:每个请求新建 server+transport,响应结束即回收。
 * readonly 拦截统一在 core createServer 按调用上下文执行(本层不再单独设清单)。
 */
import * as http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type ServerContext } from "versioncontrol-mcp/dist/index.js";
import { recordConnection } from "./mcp-connections.js";
import type { ClientRoute, PermissionMode } from "../shared/types.js";

export interface McpHttpHandle {
  port: number;
  close: () => Promise<void>;
}

let current: McpHttpHandle | null = null;

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 请求体上限,超限 413(防大请求撑爆 GUI 内存)

/** /mcp 或 /mcp/<接入名>(接入名限字母数字._-,≤40 字符) */
function parseClientPath(url: string | undefined): string | null | undefined {
  const p = (url ?? "").split("?")[0];
  const m = /^\/mcp(?:\/([A-Za-z0-9._-]{1,40}))?$/.exec(p);
  if (!m) return undefined; // 非 /mcp 路径
  return m[1] ?? null; // null=匿名 /mcp
}

function makeHandler(mode: PermissionMode, routes: Record<string, ClientRoute>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // 仅接受本机回环来源(含 Host 头校验,阻断 DNS 重绑定)
    // 主机名剥除端口后精确比较,防 127.0.0.1.evil.com 之类前缀伪造通过
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
    const hostname = bracket ? bracket[1] : hostHeader.replace(/:\d+$/, "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden: local loopback only" }));
      return;
    }
    const client = parseClientPath(req.url);
    if (req.method !== "POST" || client === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found;POST /mcp/<接入名> only" }));
      return;
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        return;
      }
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(rpcError(null, -32700, "Parse error"));
      return;
    }
    // 连接可见性:记录 initialize 握手的客户端标识(设置页展示"谁连接了本服务");
    // 子路径接入名一并记录,与握手名相互印证
    if ((body as { method?: string }).method === "initialize") {
      const ci = (body as { params?: { clientInfo?: { name?: string; version?: string } } }).params
        ?.clientInfo;
      // trim=true:裁剪只由 GUI 进程执行(桥进程默认不裁剪,消除双进程读改写竞态)
      void recordConnection("http", client ? `${client}(${ci?.name ?? "?"})` : ci?.name, ci?.version, true).catch(() => {});
    }
    // 按调用方组装上下文:路由表绑定默认项目/权限/越界档;未绑定走全局权限模式
    const route = client ? routes[client] : undefined;
    const ctx: ServerContext = {
      client: client ?? undefined,
      defaultRepo: route?.repoPath || undefined,
      permission: route?.permission ?? (mode === "readonly" ? "readonly" : "auto"),
      strict: route?.strict ?? false,
    };
    // 无状态模式:每请求一个 server+transport(SDK 推荐做法),响应结束即回收
    const server = createServer("mcp-http", ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  };
}

function listenOn(port: number, mode: PermissionMode, routes: Record<string, ClientRoute>): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer(makeHandler(mode, routes));
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

export async function startMcpHttp(
  preferredPort: number,
  mode: PermissionMode,
  routes: Record<string, ClientRoute> = {},
): Promise<McpHttpHandle> {
  await stopMcpHttp();
  let server: http.Server | null = null;
  let bound = preferredPort;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      bound = preferredPort + attempt;
      server = await listenOn(bound, mode, routes);
      break;
    } catch {
      server = null; // 端口占用,试下一个
    }
  }
  if (!server) {
    throw new Error(
      `MCP HTTP 端点启动失败:${preferredPort}~${preferredPort + 9} 均被占用`,
    );
  }
  current = {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server!.close(() => resolve());
      }),
  };
  return current;
}

export async function stopMcpHttp(): Promise<void> {
  if (current) {
    await current.close();
    current = null;
  }
}

export function mcpHttpStatus(): McpHttpHandle | null {
  return current;
}
