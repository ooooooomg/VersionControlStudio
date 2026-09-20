import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientRoute, CustomAiClient, PermissionMode, StudioSettings, Theme } from "../shared/types.js";

const DEFAULTS: StudioSettings = {
  repoPath: null,
  recents: [],
  mcpEnabled: true,
  mcpPort: 8471,
  permissionMode: "auto",
  viewStyle: "cards",
  theme: "system",
  customClients: [],
  clientRoutes: {},
};

/** 不依赖 electron app(stdio 桥也要读同一份设置) */
export function settingsFile(): string {
  const base =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "version-control-studio", "studio-settings.json");
}

/** 旧目录(paper-version-studio)遗留设置:首启用自动搬迁到新目录 */
function legacySettingsFile(): string {
  const base =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "paper-version-studio", "studio-settings.json");
}

async function readSettingsRaw(): Promise<string | null> {
  try {
    return await fs.readFile(settingsFile(), "utf8");
  } catch {
    /* 新路径还没有,试旧路径 */
  }
  try {
    const raw = await fs.readFile(legacySettingsFile(), "utf8");
    // 搬迁:写到新路径,之后只读新路径
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), raw, "utf8");
    return raw;
  } catch {
    return null;
  }
}

export async function loadSettings(): Promise<StudioSettings> {
  const raw = await readSettingsRaw();
  if (raw === null) return { ...DEFAULTS }; // 首次运行,文件尚不存在
  let s: StudioSettings;
  try {
    s = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StudioSettings>) };
  } catch {
    // 半截/损坏的设置文件(并发写或断电残留):备份后回退默认,绝不静默覆盖原件
    const backup = `${settingsFile()}.bad-${Date.now()}`;
    await fs.rename(settingsFile(), backup).catch(() => {});
    return { ...DEFAULTS };
  }
  // 归一化:confirm 权限从未实现,存量值迁移为 auto;路由表保证为对象
  if ((s.permissionMode as string) === "confirm") s.permissionMode = "auto";
  if (!s.clientRoutes || typeof s.clientRoutes !== "object" || Array.isArray(s.clientRoutes)) {
    s.clientRoutes = {};
  }
  return s;
}

export async function saveSettings(s: StudioSettings): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  // 原子写:先写临时文件再替换,避免并发/中断产生半截 JSON
  const tmp = `${settingsFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, settingsFile());
}

export async function setRepo(repoPath: string): Promise<StudioSettings> {
  const s = await loadSettings();
  s.repoPath = path.resolve(repoPath);
  s.recents = [s.repoPath, ...s.recents.filter((r) => r !== s.repoPath)].slice(0, 8);
  await saveSettings(s);
  return s;
}

export async function setService(patch: {
  mcpEnabled?: boolean;
  mcpPort?: number;
  permissionMode?: PermissionMode;
}): Promise<StudioSettings> {
  const s = await loadSettings();
  if (patch.mcpEnabled !== undefined) s.mcpEnabled = patch.mcpEnabled;
  if (patch.mcpPort !== undefined) s.mcpPort = patch.mcpPort;
  if (patch.permissionMode !== undefined) s.permissionMode = patch.permissionMode;
  await saveSettings(s);
  return s;
}

export async function setViewStyle(viewStyle: "cards" | "list"): Promise<StudioSettings> {
  const s = await loadSettings();
  s.viewStyle = viewStyle;
  await saveSettings(s);
  return s;
}

export async function setTheme(theme: Theme): Promise<StudioSettings> {
  const s = await loadSettings();
  s.theme = theme;
  await saveSettings(s);
  return s;
}

export async function removeRepo(repoPath: string): Promise<StudioSettings> {
  const s = await loadSettings();
  s.recents = s.recents.filter((r) => path.resolve(r) !== path.resolve(repoPath));
  if (s.repoPath && path.resolve(s.repoPath) === path.resolve(repoPath)) {
    s.repoPath = s.recents[0] ?? null;
  }
  await saveSettings(s);
  return s;
}

/** 整体替换自定义 AI 工具清单 */
export async function setCustomClients(list: CustomAiClient[]): Promise<StudioSettings> {
  const s = await loadSettings();
  s.customClients = list;
  await saveSettings(s);
  return s;
}

/** 设置/移除一条工具接入路由(route=null 移除;key 即接入名) */
export async function setClientRoute(key: string, route: ClientRoute | null): Promise<StudioSettings> {
  const s = await loadSettings();
  s.clientRoutes = { ...(s.clientRoutes ?? {}) };
  if (route) {
    s.clientRoutes[key] = {
      repoPath: route.repoPath ? path.resolve(route.repoPath) : undefined,
      permission: route.permission === "readonly" ? "readonly" : "auto",
      strict: !!route.strict,
    };
  } else {
    delete s.clientRoutes[key];
  }
  await saveSettings(s);
  return s;
}
