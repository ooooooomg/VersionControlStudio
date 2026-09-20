/**
 * MCP 连接记录:AI 工具每次向本服务发起 initialize 握手时记一条。
 * 存于 %APPDATA%/version-control-studio/mcp-connections.jsonl;
 * HTTP 端点与 stdio 桥是两个进程,共用此文件(纯 node 实现,桥进程可用)。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface ConnectionEvent {
  /** 本地时间 YYYY-MM-DD HH:mm:ss */
  time: string;
  transport: "http" | "stdio";
  /** clientInfo.name 原样(截断至 60 字符) */
  client: string;
  version?: string;
}

function connectionsFile(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "version-control-studio", "mcp-connections.jsonl");
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 记录一次握手;追加写(O_APPEND 语义),并发握手互不覆盖。
 * 裁剪只在 GUI 进程执行(stdio 桥传 trim=false),且改为临时文件+rename 原子替换,
 * 消除"两进程同时读改写丢行"的竞态(V1.9.2 设置文件同款修法)。
 */
export async function recordConnection(
  transport: "http" | "stdio",
  client: string | undefined,
  version?: string,
  trim = false,
): Promise<void> {
  if (!client || !client.trim()) return;
  const f = connectionsFile();
  await fs.mkdir(path.dirname(f), { recursive: true });
  const ev: ConnectionEvent = {
    time: nowStr(),
    transport,
    client: client.trim().slice(0, 60),
    version: version?.slice(0, 30),
  };
  await fs.appendFile(f, JSON.stringify(ev) + "\n", "utf8");
  if (!trim) return;
  const st = await fs.stat(f).catch(() => null);
  if (!st || st.size < 100_000) return;
  const raw = await fs.readFile(f, "utf8").catch(() => "");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length > 500) {
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, lines.slice(-200).join("\n") + "\n", "utf8");
    await fs.rename(tmp, f).catch(() => fs.rm(tmp, { force: true }));
  }
}

/** 全部握手记录,最新在前;坏行跳过 */
export async function readConnections(): Promise<ConnectionEvent[]> {
  let raw = "";
  try {
    raw = await fs.readFile(connectionsFile(), "utf8");
  } catch {
    return [];
  }
  const out: ConnectionEvent[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as ConnectionEvent);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.reverse();
}

/**
 * 把 clientInfo.name 归类到已知客户端键(与设置页 AI_CLIENTS 的 id 对齐);
 * 无法识别时返回 "other:<原名>"。
 */
export function classifyClient(name: string): string {
  const n = name.toLowerCase().replaceAll(/\s+/g, "-");
  if (n.includes("paper-version-studio") || n.includes("version-control-studio")) return "self";
  if (n.includes("claude-code") || n.includes("claude-cli")) return "claude-code";
  if (n === "claude" || n.includes("claude-desktop") || n === "claude-ai") return "claude-desktop";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("vscode") || n.includes("visual-studio-code")) return "vscode-copilot";
  if (n.includes("windsurf") || n.includes("codeium")) return "windsurf";
  if (n.includes("zcode")) return "zcode";
  return `other:${name}`;
}
