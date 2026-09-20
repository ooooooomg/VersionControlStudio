#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuditSource } from "./workspace.js";
export { resolveRepo } from "./workspace.js";
/** 统一 MCP 接口的调用上下文:工具归因 + 路由表绑定 + 按工具权限 */
export interface ServerContext {
    /** 调用方工具标识(HTTP 子路径 /mcp/<client> 或 stdio env PVC_CLIENT;空=匿名/本地) */
    client?: string;
    /** 路由表绑定的默认项目(调用未显式传 repoPath 时自动落到这里) */
    defaultRepo?: string;
    /** 该工具的权限档:readonly 拦截全部写工具(默认 auto) */
    permission?: "auto" | "readonly";
    /** 越界档位:true=操作绑定项目之外直接拒绝;false=放行但返回警告并写审计(默认) */
    strict?: boolean;
}
export declare function isWriteTool(name: string): boolean;
/** 两路径是否同一项目(Windows 大小写不敏感) */
export declare function sameRepo(a: string, b: string): boolean;
/**
 * repoPath 解析链(多工具多项目路由的核心):
 * 显式参数 > 路由表绑定项目(ctx.defaultRepo) > env PAPER_VERSION_REPO;
 * 越界(显式指向绑定项目之外):strict=true 抛错拒绝,false 返回警告文本放行。
 */
export declare function resolveRepoFor(repoPath: string | undefined, ctx: ServerContext, env?: NodeJS.ProcessEnv): {
    repo: string;
    warn: string;
};
export declare function createServer(source?: AuditSource, ctx?: ServerContext): McpServer;
/** 独立 stdio 入口:身份与路由/权限均可经环境变量注入(PVC_CLIENT / PAPER_VERSION_REPO / PVC_PERMISSION / PVC_STRICT) */
export declare function startServer(source?: AuditSource): Promise<void>;
