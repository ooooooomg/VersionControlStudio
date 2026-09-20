/**
 * AI 客户端注册表(数据驱动):接入新的 AI 工具 = 在此加一条记录。
 * 每条记录描述:配置文件候选路径 / 命令行用法 / 检测与写入方式。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { app } from "electron";
import type { AiClientInfo, AiSnippet, AiWriteResult, CustomAiClient } from "../shared/types.js";
import { loadSettings } from "./settings.js";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AiClientDef {
  id: string;
  name: string;
  kind: "json-mcp" | "command";
  /** 配置文件候选路径(支持 %APPDATA% / %USERPROFILE% 展开);json-mcp 用 */
  candidates?: string[];
  /** 命令行用法生成器;command 用(url=统一接口接入地址,工具支持 HTTP 时优先给 URL) */
  command?: (cfg: McpServerConfig, url?: string) => string;
  docs: string;
}

const expand = (p: string): string =>
  p
    .replace(/^%APPDATA%/i, process.env.APPDATA ?? "")
    .replace(/^%USERPROFILE%/i, os.homedir())
    .replaceAll("\\", "/");

export function bridgePath(selfDir: string): string {
  // selfDir = dist/main;桥与主进程同目录(见 build.mjs)
  return path.join(selfDir, "stdio-bridge.mjs");
}

/**
 * 交给 AI 客户端的桥启动方式。
 * 开发态:node 直接跑 dist/main/stdio-bridge.mjs。
 * 打包态:外部进程读不了 asar,桥经 asarUnpack 解出为真实文件;
 * 用应用自带的 Electron 以 Node 模式运行(ELECTRON_RUN_AS_NODE=1)——
 * 用户装完本应用即可用 stdio 接入,无需自装 Node.js。
 */
export function bridgeForClient(selfDir: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [bridgePath(selfDir).replace("app.asar", "app.asar.unpacked")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: "node", args: [bridgePath(selfDir)], env: {} };
}

/** 核心 stdio 服务入口(versioncontrol-mcp/dist/index.js) */
export function coreServerJs(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("versioncontrol-mcp/package.json");
  const pkg = require("versioncontrol-mcp/package.json") as { main: string };
  return path.join(path.dirname(pkgJson), pkg.main);
}

export function serverConfig(selfDir: string, repoPath: string | null, client?: string): McpServerConfig {
  const bridge = bridgeForClient(selfDir);
  const cfg: McpServerConfig = { command: bridge.command, args: bridge.args };
  const env: Record<string, string> = { ...bridge.env };
  if (repoPath) env.PAPER_VERSION_REPO = repoPath;
  if (client) env.PVC_CLIENT = client; // 工具身份:按路由表注入默认项目/权限(与 HTTP 子路径同机制)
  if (Object.keys(env).length > 0) cfg.env = env;
  return cfg;
}

/** 把 serverConfig 排成一条可直接粘贴的 shell 命令(claude mcp add 等 -- 后半段) */
function stdioCommand(cfg: McpServerConfig): string {
  const envs = Object.entries(cfg.env ?? {})
    .map(([k, v]) => `--env ${k}=${v}`)
    .join(" ");
  const args = [cfg.command, ...cfg.args].map((a) => `"${a}"`).join(" ");
  return `${envs ? envs + " " : ""}${args}`;
}

/** 统一接口接入 URL:每个工具用 /mcp/<接入名> 子路径,服务端据此归因并按路由表路由 */
export function endpointUrl(port: number, client?: string): string {
  return `http://127.0.0.1:${port}/mcp${client ? `/${client}` : ""}`;
}

export const AI_CLIENTS: AiClientDef[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "json-mcp",
    candidates: ["%APPDATA%/Claude/claude_desktop_config.json"],
    docs: "https://claude.ai/download",
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "json-mcp",
    candidates: ["%USERPROFILE%/.cursor/mcp.json"],
    docs: "https://cursor.com/docs/context/mcp",
  },
  {
    id: "vscode-copilot",
    name: "VS Code Copilot",
    kind: "json-mcp",
    candidates: ["%USERPROFILE%/.vscode/mcp.json", "%APPDATA%/Code/User/mcp.json"],
    docs: "https://code.visualstudio.com/docs/copilot/chat/mcp-servers",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "json-mcp",
    candidates: ["%USERPROFILE%/.codeium/windsurf/mcp_config.json"],
    docs: "https://docs.windsurf.com/windsurf/cascade/mcp",
  },
  {
    id: "claude-code",
    name: "Claude Code(CLI)",
    kind: "command",
    command: (cfg, url) =>
      url
        ? `claude mcp add --transport http version-control-studio "${url}"`
        : `claude mcp add version-control-studio --scope user -- ${stdioCommand(cfg)}`,
    docs: "https://claude.com/docs/claude-code",
  },
  {
    id: "zcode",
    name: "ZCode",
    kind: "command",
    command: (cfg, url) =>
      url
        ? `在 ZCode MCP 设置中添加 server:type=url,url="${url}";若仅支持 command 型:type=url 不可用时用 ${stdioCommand(cfg)} 并按需加 env={"PVC_CLIENT":"<接入名>"}`
        : `在 ZCode MCP 设置中添加 server:${stdioCommand(cfg)}(或在 ZCode 插件设置中添加本仓库 main/core 目录,启用其 .zcode-plugin 插件壳)`,
    docs: "https://zcode.ai",
  },
];

function resolveCandidates(def: AiClientDef): string[] {
  return (def.candidates ?? []).map(expand);
}

/** 用户自定义 AI 工具(持久化于设置文件) */
export async function loadCustomClients(): Promise<CustomAiClient[]> {
  return (await loadSettings()).customClients ?? [];
}

export async function listClients(
  selfDir: string,
  repoPath: string | null,
): Promise<AiClientInfo[]> {
  void selfDir;
  void repoPath;
  const out: AiClientInfo[] = [];
  for (const def of AI_CLIENTS) {
    let configPath: string | undefined;
    let installed = false;
    if (def.kind === "json-mcp") {
      const cands = resolveCandidates(def);
      configPath = cands[0];
      for (const c of cands) {
        if (await exists(c)) {
          configPath = c;
          installed = true;
          break;
        }
      }
    }
    out.push({ id: def.id, name: def.name, kind: def.kind, configPath, installed, docs: def.docs });
  }
  for (const c of await loadCustomClients()) {
    out.push({
      id: "custom:" + c.id,
      name: c.name,
      kind: "custom",
      configPath: c.configPath,
      installed: false,
      docs: "识别关键词: " + c.match,
    });
  }
  return out;
}

export async function snippet(
  selfDir: string,
  repoPath: string | null,
  id: string,
  client?: string,
): Promise<AiSnippet> {
  const cfg = serverConfig(selfDir, repoPath, client);
  const settings = await loadSettings();
  const url = endpointUrl(settings.mcpPort, client);
  const custom = settings.customClients?.find((c) => "custom:" + c.id === id);
  if (custom) {
    return {
      text: [
        `HTTP 端点(统一接口,推荐): ${url}`,
        `stdio 命令: ${stdioCommand(cfg)}${client ? `(另加 env PVC_CLIENT=${client}${repoPath ? `, PAPER_VERSION_REPO=${repoPath}` : ""})` : ""}`,
        `识别关键词: ${custom.match}`,
      ].join("\n"),
      configPath: custom.configPath,
    };
  }
  const def = AI_CLIENTS.find((d) => d.id === id);
  if (!def) throw new Error(`未知 AI 客户端: ${id}`);
  if (def.kind === "command") {
    return { text: def.command!(cfg, url) };
  }
  const cands = resolveCandidates(def);
  let configPath = cands[0];
  for (const c of cands) {
    if (await exists(c)) {
      configPath = c;
      break;
    }
  }
  const entry = {
    command: cfg.command,
    args: cfg.args,
    ...(cfg.env ? { env: cfg.env } : {}),
  };
  const text = JSON.stringify(
    { mcpServers: { "version-control-studio": entry } },
    null,
    2,
  );
  return { text, configPath };
}

async function exists(p?: string): Promise<boolean> {
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 写入配置:先时间戳备份已有文件,再 JSON 合并 mcpServers 键(保留其他内容) */
export async function writeConfig(
  selfDir: string,
  repoPath: string | null,
  id: string,
  client?: string,
): Promise<AiWriteResult> {
  const custom = (await loadCustomClients()).find((c) => "custom:" + c.id === id);
  const def = AI_CLIENTS.find((d) => d.id === id);
  if (!def && !custom) throw new Error(`未知 AI 客户端: ${id}`);
  if (def && def.kind !== "json-mcp") {
    throw new Error(`${def.name} 不支持自动写入,请复制命令/配置手动添加`);
  }
  if (custom && !custom.configPath) {
    throw new Error(`${custom.name} 未配置配置文件路径,无法自动写入;可编辑该自定义工具补充路径`);
  }
  const cands = custom ? [custom.configPath!] : resolveCandidates(def!);
  let file = cands[0]!;
  let old: string | null = null;
  for (const c of cands) {
    try {
      old = await fs.readFile(c, "utf8");
      file = c;
      break;
    } catch {
      /* 该候选不存在,试下一个 */
    }
  }
  let data: Record<string, unknown> = {};
  let backup: string | null = null;
  if (old !== null) {
    try {
      data = JSON.parse(old) as Record<string, unknown>;
    } catch {
      // 决不覆盖无法解析的既有配置(防止用户手写配置被清空)
      throw new Error(
        `配置文件已存在但不是合法 JSON,拒绝写入以免破坏:${file}(请先人工修复或备份)`,
      );
    }
    backup = `${file}.pvc-backup-${Date.now()}`;
    await fs.writeFile(backup, old, "utf8");
  }
  const cfg = serverConfig(selfDir, repoPath, client);
  const servers = (data.mcpServers as Record<string, unknown>) ?? {};
  servers["version-control-studio"] = {
    command: cfg.command,
    args: cfg.args,
    ...(cfg.env ? { env: cfg.env } : {}),
  };
  data.mcpServers = servers;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  return { file, backup };
}

/** 连通性检测:以 ELECTRON_RUN_AS_NODE 起 stdio 桥,做 initialize + tools/list 握手 */
export async function healthCheck(
  selfDir: string,
  repoPath: string | null,
): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const { spawn } = await import("node:child_process");
  const bridge = bridgeForClient(selfDir);
  return new Promise((resolve) => {
    const child = spawn(bridge.command, bridge.args, {
      env: {
        ...process.env,
        ...bridge.env,
        ...(repoPath ? { PAPER_VERSION_REPO: repoPath } : {}),
      },
      windowsHide: true,
    });
    let buf = "";
    let toolCount = 0;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: toolCount > 0, toolCount, error: toolCount > 0 ? undefined : "握手超时" });
    }, 15000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { tools?: unknown[] };
          };
          if (msg.id === 3 && msg.result?.tools) {
            toolCount = msg.result.tools.length;
            clearTimeout(timer);
            child.kill();
            resolve({ ok: true, toolCount });
            return;
          }
        } catch {
          /* 非整行 JSON,跳过 */
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, toolCount: 0, error: String(err) });
    });
    const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "version-control-studio", version: app.getVersion() } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  });
}
