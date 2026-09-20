# VersionControl Studio

**给 AI(和人)用的项目版本管理器**:每一次修改必须登记版本号、写清改了什么,任何版本可回滚。git 驱动,服务端强制校验,AI 绕不过。

[![CI](https://github.com/ooooooomg/VersionControlStudio/actions/workflows/ci.yml/badge.svg)](https://github.com/ooooooomg/VersionControlStudio/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/ooooooomg/VersionControlStudio)](https://github.com/ooooooomg/VersionControlStudio/releases/latest)
[![npm](https://img.shields.io/npm/v/versioncontrol-mcp)](https://www.npmjs.com/package/versioncontrol-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Windows 桌面应用(Electron)内置 MCP 服务端,一套核心三种入口:图形界面、HTTP MCP、stdio MCP——人与 AI 看到的是同一份数据,写操作全部留审计。

## 30 秒上手:你是哪种用户?

| 你是 | 拿到什么 | 需要预装 |
|---|---|---|
| ① 想要图形界面 | 安装包 `Setup.exe`,双击装好 | 仅 Git(应用会自动检测并引导安装) |
| ② 只要给 AI 工具接 MCP | 一行 `npx` 配置,零安装 | Node.js ≥ 20 |
| ③ 开发者 | 源码构建 | Node.js ≥ 20、Git、npm |

---

## ① 桌面应用(开箱即用)

1. 到 [Releases](https://github.com/ooooooomg/VersionControlStudio/releases/latest) 下载:
   - `VersionControlStudio-x.x.x-Setup.exe` —— 安装版(开始菜单/桌面快捷方式、卸载器、应用内自动更新);
   - `VersionControlStudio-x.x.x-portable.exe` —— 绿色版,免安装直接运行。
2. 双击运行。若 Windows SmartScreen 弹窗(应用未做代码签名):点 **更多信息 → 仍要运行**。
3. 首次启动若未检测到 Git,会弹出引导(一条 winget 命令或官网下载,装完重启应用即可)。
4. 打开或新建项目文件夹 → 应用自动将其初始化为受管工作区。
5. 让 AI 接入:**设置 → Agent 工具连接** → 选你的 AI 工具(Claude Desktop / Cursor / VS Code Copilot / Windsurf / Claude Code / ZCode)→ **一键写入** 或复制配置。HTTP 端点 `http://127.0.0.1:8471/mcp` 随应用自动启动,推荐优先使用。

> 安装版写出的 stdio MCP 配置直接使用应用自带的运行时,**不需要用户安装 Node.js**。

## ② 只要 MCP(无界面)

任何支持 MCP 的客户端(Claude Desktop、Cursor、ZCode 等),把服务端配置加进去即可:

```json
{
  "mcpServers": {
    "version-control-studio": {
      "command": "npx",
      "args": ["-y", "versioncontrol-mcp"]
    }
  }
}
```

- 可选环境变量 `PAPER_VERSION_REPO=<项目绝对路径>`:缺省工作区;不设则每次调用传 `repoPath` 参数。
- 26 个 `vcs_*` 工具:状态/版本/回滚/并行分支/审计,详见 [core/README.md](core/README.md)。

**Claude Desktop 一键安装**:到 [Releases](https://github.com/ooooooomg/VersionControlStudio/releases/latest) 下载 `versioncontrol-mcp-x.x.x.mcpb`,双击即装(MCP Bundle 格式)。

**装配套 skill(推荐)**:让 AI 主动按正确工作流使用这组工具——

```bash
npx skills add ooooooomg/VersionControlStudio
```

**作为 Claude Code / ZCode 插件安装**(MCP 服务 + skill 一起装):

```
# Claude Code / ZCode
plugin marketplace add ooooooomg/VersionControlStudio
plugin install version-control-studio@version-control-studio
```

## ③ 开发者:源码构建

```bash
# 核心引擎(所有业务规则的唯一实现处)
cd core
npm install && npm test && npm run build

# 桌面应用(通过 file:../core 链接核心)
cd ../studio
npm install
npm start        # 构建 + 启动
npm run smoke    # 无头自检
npm run dist     # 本地打包:release/ 下出 Setup.exe + portable.exe
```

CI 在每次 push/PR 自动跑核心测试与桌面端冒烟;推 `v*` 标签自动发布 Releases + npm + MCPB(见 `.github/workflows/`)。

---

## 它怎么管版本

一个项目 = 一个文件夹,初始化后只允许三类产物,其余一律拒绝提交:

```
项目文件夹/
├── main/               项目主体,用户与 AI 只在这里修改
├── V x.y.z/            每版本一个文件夹:更新目的.md + 改动日志.md
├── 工作区日志.md        全部版本流水
└── .vcs/               工具状态(registry + 审计日志)
```

- **版本号 `V{X}.{Y}.{Z}`**:X=里程碑 / Y=功能迭代 / Z=微调,commit 时定版;git commit + annotated tag 双重记录;
- **服务端强制校验**:begin/commit 必须配对、空改动拒绝、越界文件拒绝、会话令牌所有权校验、同仓写操作串行化;
- **并行分支**:git worktree 实现的 `vcs/task/*` 分支,多个 AI 工具可并行开工、合并定版;
- **回滚不改写历史**:恢复到任意版本本身也是一条可追溯的版本记录。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1` 并校验 Host 头;
- 权限模式 `readonly / auto` 控制每个 AI 工具的写操作,可按工具绑定默认项目与越界策略(警告或拒绝);
- 全部写操作追加审计日志(`.vcs/audit.log`);提交使用路径限定,不碰工作区外文件。

## License

[MIT](LICENSE) © Ash
