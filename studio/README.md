# VersionControl Studio 技术文档

本文档面向维护者与接入方,描述系统的构成、数据模型、接口与构建方式。

## 1. 项目概述

VersionControl Studio 是一个 Windows 桌面应用,为 AI 辅助的项目编辑提供基于 git 的强制版本管理。它解决的问题是:AI 反复修改项目文件后,内容难以追溯。软件要求每次修改都登记版本号,生成可读的变更说明,并保证任何版本都可以回滚。

软件自带 MCP(Model Context Protocol)服务端。AI 工具(ZCode、Cursor、Claude 系列等)通过一个 URL 或一条 stdio 命令即可调用全部版本管理操作;人通过图形界面操作同一套核心。人和 AI 看到的是同一份数据。

## 2. 系统组成

| 组件 | 位置 | 说明 |
|---|---|---|
| 核心引擎 versioncontrol-mcp | `core`(npm 包 [`versioncontrol-mcp`](https://www.npmjs.com/package/versioncontrol-mcp)) | TypeScript 库,实现工作区模型、版本规则、git 操作、MCP 工具定义与 CLI。编译产物为 `dist/`(ESM)。所有业务规则只在这一处实现 |
| 桌面应用 VersionControl Studio | `studio`(npm 包 `versioncontrol-studio`) | Electron 应用。GUI 四视图、内置 HTTP MCP 端点、stdio 桥、AI 客户端配置写入、应用内自动更新。通过 npm 符号链接引用核心引擎(`node_modules/versioncontrol-mcp -> ../core`,同工作区内部),核心重建后即刻生效 |
| 触发 skill | `core/skills/version-control-studio/` | 告知 AI 工具:用户说"对此工作区进行版本管理"时,先 `vcs_analyze` 分析文件夹,再按方案 `vcs_init`。经 `npx skills add ooooooomg/VersionControlStudio` 或插件市场分发 |

三层入口(GUI 的 IPC、HTTP MCP、stdio MCP)调用同一个核心库,校验规则不可绕过。

## 3. 工作区模型

一个项目 = 一个工作区文件夹。初始化后,文件夹内只允许三类产物:

```
项目文件夹/
├── main/               项目主体。用户与 AI 只在这里修改文件
├── V X.Y.Z/            每个版本一个文件夹:更新目的.md + 改动日志.md
│   └── 项目副本/        回滚到该版本时物化的完整副本(按需生成)
├── 工作区日志.md        全部版本的流水记录(需求、改动、明细指引)
└── .vcs/               工具状态(不参与"三类"判定,内部目录)
    ├── registry.json   注册表:标题、创建时间、全部版本记录、进行中状态
    └── audit.log       操作审计:时间 | 来源 | 操作 | 结果,只追加
```

越界规则:`vcs_commit` 前会检查工作区根目录,存在三类之外的文件时拒绝提交并逐个列出。`.gitignore`、`.gitattributes` 等仓库机械文件放行。该规则的目的:保证版本文件夹与项目内容不被无关文件污染,回滚语义始终明确。

初始化时会做一次"收编":如果文件夹已有内容且 `main/` 为空,现有文件会被移入 `main/`。git 身份缺失时自动配置本地身份(PVC Studio / pvc-studio@local)。

## 4. 版本号规则

格式 `V{X.Y.Z}`,初始版本一律 V1.0.0:

- **X(里程碑)**:重大阶段推进或重大重构。提交时 `bump: "major"` 使 X+1,Y、Z 归零。
- **Y(功能迭代)**:实质内容修改(章节、论点、实验、图表)。默认级别,`bump: "content"` 或缺省。
- **Z(微调)**:错别字、排版、格式类修改。`bump: "polish"`。

版本号在 **commit 时定版**,begin 阶段只写占位号。每个版本在 git 中对应一个 annotated tag(V 编号即 tag 名),版本记录同时写入 `registry.json`。

回滚不改写历史:`vcs_rollback` 把 `main/` 恢复为目标版本内容(即以该版本为主线继续),把该版本完整副本物化到 `V<目标>/项目副本/`,然后以**新版本号**提交("回滚到某版本"本身也是一条可追溯的版本记录)。副本只是浏览用快照:内容同时保存在该版本的 git tag 中,可用 `vcs_delete_copy` 删除、`vcs_restore_copy` 恢复,均以独立的副本管理提交留痕。

## 5. 生命周期

```
vcs_init                    创建工作区结构,首个 commit
   │
vcs_begin(requirement)      记录用户需求原文,锁定基线 commit
   │
   (AI / 用户修改 main/ 内文件)
   │
vcs_commit(summary, bump)   越界检查 → 定版号 → 生成 V 文件夹两份文档
                            → 追加工作区日志 → git 提交(限定路径)→ 打 tag
```

约束:`begin` 与 `commit` 必须配对;无修改的空提交被拒绝;提交范围限定为 `main/`、`工作区日志.md`、`.vcs/`、新版本文件夹,用户暂存区里的其他内容不会被卷入。

## 6. MCP 工具参考

服务名 `vcs-workspace`,共 26 个工具。除 `vcs_analyze` 外均有可选参数 `repoPath`(工作区绝对路径;缺省时依次取环境变量 `PAPER_VERSION_REPO`、当前目录;多项目环境必须显式传入)。

| 工具 | 参数 | 作用 |
|---|---|---|
| `vcs_status` | — | 当前状态:最新版本、进行中版本、变更数、越界文件。会话第一步应调用 |
| `vcs_init` | `title` | 把文件夹初始化为工作区 |
| `vcs_begin` | `requirement` | 开始新版本,记录用户需求 |
| `vcs_commit` | `summary`,`bump?`,`exclude?` | 收尾定版,生成 V 文件夹并提交;`exclude` 列出的路径不入本版本,原样留在工作区(隔离无关半成品) |
| `vcs_rollback` | `code`,`reason?`,`discardDirty?` | 回滚 main/ 到指定版本,物化副本,登记为新版本 |
| `vcs_delete_copy` | `code` | 删除回滚物化的项目副本;历史与 tag 不变,可随时恢复 |
| `vcs_restore_copy` | `code` | 重新物化已删除的项目副本(取自版本历史,不影响 main/) |
| `vcs_versions` | — | 全部版本清单(JSON) |
| `vcs_read_doc` | `which: purpose\|changes\|workspaceLog`,`code?` | 读取更新目的 / 改动日志 / 工作区日志全文 |
| `vcs_diff` | `from`,`to?`,`mode?: stat\|full` | main/ 在两版本间差异;to 缺省为当前工作区;full 上限 500 行 |
| `vcs_audit` | `limit?` | 最近 N 条审计流水(默认 50) |
| `vcs_migrate` | `newRepoPath`,`title`,`oldRepoPath` | 把旧模型论文库(paper_versions/,CN/EN/TEX 编号)迁移为 v3 工作区 |
| `vcs_analyze` | `dir` | 分析任意文件夹的结构、体量,给出转为标准工作区的整理方案 |
| `vcs_log` | `limit?` | 版本链流水(git log 摘要,最新在前) |
| `vcs_branches` | — | 并行分支清单、temp 待处理条目与合并冲突状态 |
| `vcs_branch_begin` | `requirement`,`name?`,`base?`,`assignee?` | 创建并行分支(git worktree),返回会话令牌 |
| `vcs_branch_commit` | `name`,`summary`,`token?` | 分支内检查点提交(不占 V 版本号) |
| `vcs_branch_merge` | `name`,`summary?`,`token?`,或 `abort:true` | 分支合并进 main/ 并定版;冲突挂起后再次调用完成 |
| `vcs_branch_discard` | `name`,`token?`,`force?` | 删除分支工作树与 ref(未合并修改不可恢复) |
| `vcs_branch_assign` | `name`,`assignee?` | 改派/清除分支指派的管理工具 |
| `vcs_branch_rollback` | `name`,`to?`,`token?`,`force?` | 分支工作树回退到某检查点 |
| `vcs_branch_update` | `name`,`token?` | 把 main/ 最新合入分支(对齐主干) |
| `vcs_branch_adopt` | `name`,`requirement`,`assignee?` | 收编仓库现存未登记的 vcs/task/* 孤儿分支 |
| `vcs_temp_save` | `summary`,`name?`,`token?` | 无法提交时把已产生变化保全到 temp/<name>/ |
| `vcs_temp_apply` | `name` | 把 temp/<name>/ 的变化写回 main/ |
| `vcs_temp_discard` | `name` | 丢弃 temp/<name>/ 及其登记 |

写工具共 18 个:`vcs_init`、`vcs_begin`、`vcs_commit`、`vcs_rollback`、`vcs_delete_copy`、`vcs_restore_copy`、`vcs_migrate`、9 个 `vcs_branch_*` 与 3 个 `vcs_temp_*`。其余为只读。

## 7. AI 工具接入

**方式一:HTTP(推荐)**。软件启动即在 `http://127.0.0.1:8471/mcp` 提供 streamable-HTTP MCP 服务(端口被占用时自动依次 +1 重试,最多 10 个)。支持 URL 配置的客户端直接填该地址。仅接受本机回环来源,并校验 Host 头。

**方式二:stdio**。不支持 URL 的客户端执行:
- 开发态:`node <仓库>/studio/dist/main/stdio-bridge.mjs`
- 安装版打包态:由设置页"一键写入"自动生成,形如 `"<安装目录>\VersionControlStudio.exe" "<安装目录>\resources\app.asar.unpacked\dist\main\stdio-bridge.mjs"` + `ELECTRON_RUN_AS_NODE=1` 环境变量——复用应用自带运行时,**用户无需安装 Node.js**(桥与核心经 `asarUnpack` 解出为真实文件,外部进程可读)。

stdio 桥以独立进程运行,与 HTTP 端点共用同一核心。注意:它是独立进程,因此核心的跨进程防护(见第 9 节)是必要的。

**方式三:设置页写入**。设置 → AI 工具注册:软件可检测本机已装的 AI 客户端配置,一键写入(写入前自动备份)或生成配置片段供复制。

**权限模式**(设置页选择,作用于 AI 通道):

| 模式 | 行为 |
|---|---|
| `readonly` | 拦截全部 18 个写工具(名单以 core 的 WRITE_TOOLS 为单一事实来源),返回明确错误 |
| `auto` | 直接执行,全部写入审计日志(默认) |

**确认已接入**:设置页各客户端行显示"已检测到配置";或对端点做 initialize + tools/list 握手,应返回 26 个工具。

## 8. 桌面应用

四个视图,左侧导航:

- **我的项目**:项目卡片(名称、创建时间、最后更新时间、最新版本号),卡片/列表两种样式;每卡片有"打开文件夹"与"删除项目"(仅移出管理,不删文件,需确认);"新建项目"全流程无 AI 参与:选位置 → 命名 → 自动建工作区并定版 V1.0.0。
- **时间线**:版本按列表展示,选中某版显示渲染后的 更新目的.md / 改动日志.md;提供"回滚到此版本"(需确认)、副本管理("删除副本"/"恢复副本",针对回滚物化的 V<目标>/项目副本/)与"打开文件夹"。
- **版本对比**:任选两个 V 版本,展示文件统计与逐文件差异(自实现行级 LCS,超过 600 万单元格自动降级为整文件标记,避免界面卡死)。
- **设置**:工作区选择与最近列表;MCP 服务开关与端口;权限模式;外观(跟随系统 + GitHub 风格深浅配色 5 套);AI 工具注册。

刷新机制:文件监视(递归 fs.watch,500ms 防抖)推送即时刷新;另有 15 秒轮询兜底(页签隐藏时暂停)。实测空闲轮询成本约 0.3% 单核。

## 9. 安全与数据完整性

- **网络边界**:HTTP 服务只绑定 127.0.0.1;校验 Host 头;请求体仅接受 POST /mcp。
- **权限闸门**:readonly 模式按工具名拦截写操作(名单以 core 的 WRITE_TOOLS 为单一事实来源,现共 18 个,覆盖 branch 与 temp 工具)。
- **并发控制**(2026-09-16 修复):核心所有写操作(init/begin/commit/rollback)按仓库路径串行化(进程内互斥);commit 在产生任何文件副作用前重读注册表做乐观校验,发现其他进程已推进则取消本次提交;提交失败的回退只在注册表仍是自己写入的状态时执行,避免覆盖其他进程已登记的版本。起因:并发提交会把已成功版本从注册表抹掉并留下孤儿 tag,已有回归测试覆盖(`test/race.test.ts`)。
- **提交隔离**:git commit 使用路径限定,只收管理路径的变更;`git add` 不使用排除式 pathspec(Windows 下该写法会静默失败,改为正向路径 + 事后 reset)。
- **审计**:全部写操作追加 `.vcs/audit.log`,来源标记区分 GUI 与各 AI 客户端;版本记录里有收尾来源,GUI 据此展示"由谁提交"。
- **迁移兼容**:`vcs_migrate` 把旧模型论文库(`paper_versions/`,CN/EN/TEX 编号)迁移为 v3 工作区,旧库原样保留(v2 引擎已移除,旧库支持仅经此迁移通道)。

## 10. 构建与测试

核心引擎(仓库内 `core`,即 npm 包 versioncontrol-mcp):

```bash
npm install
npm test             # vitest,6 个文件 67 个用例(含并发竞态与未登记提交检测)
npm run build        # tsc → dist/(ESM)
```

桌面应用(仓库内 `studio`):

```bash
npm install          # 会符号链接 ../core
npm run build        # tsc + esbuild,产物在 dist/
npm start            # 构建 + 启动
npm run smoke        # 无头自检
npm run dist         # electron-builder 本地打包 → release/(NSIS 安装器 + portable 绿色版)
npm run dist:publish # 打包并发布到 GitHub Releases(CI 用,需 GH_TOKEN)
```

发布链路(`.github/workflows/`):CI 每次 push/PR 跑核心测试 + 桌面端冒烟;推 `v*` 标签触发 Release——自动打包双产物并发布 GitHub Releases、发布 npm 包、生成 MCPB 一键安装包与源码 zip 一并附加;`registry-publish.yml` 向官方 MCP Registry 提交 server.json(独立运行,失败不影响 Release)。

应用内自动更新:electron-updater(GitHub provider),仅安装版生效;设置页"检查更新"手动触发,确认后下载并重启安装。首次启动检测 git 缺失并弹引导(winget / 官网)。产物未做代码签名:SmartScreen 首次运行需"更多信息 → 仍要运行"。

技术栈:Electron 37 + React 18 + TypeScript,esbuild 直接打包(无 vite)。渲染进程开启 contextIsolation 与 sandbox,通过 contextBridge 暴露 `pvc:*` IPC。图标与快捷方式脚本在 `scripts/`(icon.html 生成 VC 图标,create-shortcut.ps1 建桌面快捷方式)。

## 11. 数据与文件位置

| 数据 | 位置 |
|---|---|
| 应用设置 | `%APPDATA%\version-control-studio\studio-settings.json`(repoPath、recents、mcpEnabled、mcpPort、permissionMode、viewStyle、theme;旧目录 `paper-version-studio` 首次运行自动搬迁) |
| 工作区注册表/审计 | 各工作区 `.vcs\registry.json`、`.vcs\audit.log` |
| 版本历史 | git 提交 + tag(在各自工作区仓库内) |
| ZCode 触发 skill | `C:\Users\<用户>\.zcode\skills\version-control-studio\SKILL.md` |

## 12. 已知限制

- 回滚按路径逐个 `git checkout`,版本内文件数达到千级时耗时线性增长(当前规模无感知)。
- stdio 桥与 GUI 是两个进程,跨进程并发依赖乐观校验,理论上仍存在极小的检查-写入窗口;同进程并发已完全串行化。
- audit.log 只追加不清理;按当前使用密度(每次操作 2-3 行)多年内不会成为问题。
- 文件监视防抖无最长等待:持续不断的小间隔写入会推迟 GUI 刷新,由 15 秒轮询兜底。
- Windows 下 `git add` 排除式 pathspec 静默失效的问题以"正向路径 + reset"方式规避,依赖 git 行为不变。
