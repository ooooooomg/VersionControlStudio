# versioncontrol-mcp

git 驱动的工作区版本控制核心,以 **MCP server + CLI** 双形态接入 AI 工具(ZCode / Claude Code / Claude Desktop / Cursor / 任何支持 MCP 或能跑命令行的 agent)。桌面端 VersionControl Studio(`../studio`)与全部 AI 通道调用同一个核心,校验规则不可绕过。

npm 包 [`versioncontrol-mcp`](https://www.npmjs.com/package/versioncontrol-mcp):`npx -y versioncontrol-mcp` 一行接入,无需克隆本仓库。

## 核心模型(工作区 v3)

一个项目 = 一个工作区文件夹,初始化后只允许三类产物:`main/`(项目主体,只在这里修改)、`V X.Y.Z/`(每版本文件夹:更新目的.md + 改动日志.md)、`工作区日志.md`;工具状态在 `.vcs/`(registry + 审计)。

- **版本 = git commit + annotated tag**:编号 `V{X.Y.Z}`(X 里程碑 / Y 功能迭代 / Z 微调),commit 时定版,回滚不改写历史(以新版本号登记)
- **服务端强制校验**(AI 绕不过):begin/commit 必须配对、空改动拒绝、越界文件拒绝、会话令牌所有权校验、同仓写操作串行化
- **并行分支**:基于 git worktree 的 `vcs/task/*` 分支,支持检查点、合并定版、指派管理工具
- **审计**:全部写操作追加 `.vcs/audit.log`,提交范围限定管理路径,不碰工作区外文件

## 安装与接入

**npm 包(推荐,无需克隆仓库)** —— 客户端 MCP 配置:

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

需要 Node.js ≥ 20 与 git。可选环境变量 `PAPER_VERSION_REPO=<工作区绝对路径>` 设默认工作区。

**从源码运行**:

```bash
cd core
npm install && npm run build
```

### Claude Desktop 一键安装(MCPB)

仓库 Release 页提供 `versioncontrol-mcp-<版本>.mcpb`,Claude Desktop 下载后双击即装;本地可用 `node scripts/make-mcpb.mjs` 自行打包。

### ZCode / Claude Code(插件方式,含 skill)

本目录是插件壳(`.zcode-plugin/plugin.json` 与 `.claude-plugin/plugin.json` 均已声明 MCP server 与 skill;server 入口以 `${CLAUDE_PLUGIN_ROOT}` 相对插件根解析,换机器无需改配置)。两种装法:

- 一行安装(推荐):先 `plugin marketplace add ooooooomg/VersionControlStudio` 添加市场(仓库根 `.claude-plugin/marketplace.json`),再 `plugin install version-control-studio@version-control-studio`;
- 本地路径:在插件设置中添加 `<仓库>/core` 目录。

skill 也可单独安装:`npx skills add ooooooomg/VersionControlStudio`(vercel-labs skills CLI,支持 75+ 客户端)。

### 任何 MCP 客户端(stdio,指向本仓库构建产物)

```json
{
  "mcpServers": {
    "version-control-studio": {
      "command": "node",
      "args": ["<仓库绝对路径>/core/dist/index.js"]
    }
  }
}
```

桌面端开着时更推荐 HTTP 直连 `http://127.0.0.1:8471/mcp`(见 `../studio/README.md`)。无需绑定固定项目;如需默认工作区,可设环境变量 `PAPER_VERSION_REPO`,否则每次调用传 `repoPath` 参数。

### CLI(无 MCP 配置时的等价通道)

全局安装后直接用 `versioncontrol-mcp` 命令(`npm i -g versioncontrol-mcp`),或从仓库根执行:

```bash
node core/dist/cli.js status  --dir "D:/my-project"
node core/dist/cli.js begin   --dir "D:/my-project" --requirement "按审稿意见重写第 4 节"
node core/dist/cli.js commit  --dir "D:/my-project" --summary "重写 4.2 节并更新表 3" --token <begin 返回的会话令牌>
```

子命令:init / begin / commit[--exclude] / status / versions / log / read / diff / analyze / rollback / migrate / delete-copy / restore-copy / branch-begin / branch-commit / branch-assign / branch-adopt / branch-rollback / branch-update / branch-merge / branch-discard / branches / temp-save / temp-apply / temp-discard。

## MCP 工具一览(26 个)

- 只读:`vcs_status` `vcs_versions` `vcs_read_doc` `vcs_diff` `vcs_log` `vcs_audit` `vcs_analyze` `vcs_branches`
- 写(readonly 权限档共拦截 18 个):`vcs_init` `vcs_begin` `vcs_commit` `vcs_rollback` `vcs_delete_copy` `vcs_restore_copy` `vcs_migrate` + 9 个 `vcs_branch_*` + 3 个 `vcs_temp_*`

除 `vcs_analyze` 外均有可选参数 `repoPath`(工作区绝对路径;缺省时取环境变量 `PAPER_VERSION_REPO`,再缺省取当前目录)。完整工作流与纪律见 `skills/version-control-studio/SKILL.md` 与 `../studio/README.md`。

## 开发

```bash
npm test        # vitest:6 个测试文件 67 个用例(含并发竞态、所有权与身份校验)
npm run build   # tsc → dist/(ESM)
```

已知平台注意:实测 git for Windows 上 `git add` 携带 `:(exclude)` pathspec 会静默失效,因此 add 只用正向路径,再对暂存区做排除回退(`src/git.ts: addPaths`)。
