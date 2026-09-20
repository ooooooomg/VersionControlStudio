---
name: version-control-studio
description: VersionControl Studio 工作区版本控制(git 驱动,V X.Y.Z 统一版本号,MCP 工具强制校验)。**当用户说「创建分支」「新建分支」「删除分支/删减分支」「在分支 xx 上变更/开发」「合并分支」「把分支交给某工具管理」时,必须按「并行任务分支」章节用 vcs_branch_* 工具链执行**。**当用户说"对此工作区进行版本管理/对这个文件夹做版本控制/纳入版本管理"或要求保存版本、回滚、记录改动、查看版本时,必须使用本 skill**:对新文件夹执行 vcs_analyze 分析 → vcs_init 初始化为标准工作区;对既有文件夹同样先 vcs_analyze 深入分析再整理。触发词:版本管理、版本控制、纳入版本管理、保存版本、新版本、回滚、V1.0.0、vcs、工作区、main、更新目的、改动日志。
---

# VersionControl Studio — 工作区版本控制

## 工作区模型(铁律)

一个项目 = 一个工作区文件夹,内部**只允许三类产物**:

```
工作区/
├── main/            # 项目真身 —— 只允许在这里修改文件
├── V X.Y.Z/         # 每版本子文件夹:更新目的.md + 改动日志.md(回滚时物化项目副本)
├── 工作区日志.md     # 用户需求与 AI 改动总账
└── .vcs/            # 工具内部状态(registry + 审计)
```

根目录出现其他文件 = 越界,vcs_commit 会拒绝。**绝不把项目文件写到 main/ 之外。**

## 「对此工作区进行版本管理」标准流程(强制)

1. **`vcs_analyze {dir}`** —— 深入分析目标文件夹:规模/类型分布/是否已是工作区/整理方案。
2. 分支处理:
   - **未纳管** → `vcs_init {repoPath, title}`:全部内容收编进 main/(结构原样保留),初始化 git 与日志;**随后立即 `vcs_begin` + `vcs_commit` 将当前状态列为初始版本 V1.0.0**(bump:"major")。
   - **已是工作区** → `vcs_status` 检查:有进行中版本则收尾;有越界文件则报告并征询用户处理;无问题则汇报现状(版本数/最新版本)。
3. 整理完成后向用户汇报:主文件夹位置、版本数、初始版本号、后续使用方式。

## 日常循环(每次用户提出修改需求)

1. 第一步 `vcs_status`:确认当前版本/进行中/越界。只信工具实况,禁止凭记忆断言。
2. `vcs_begin {requirement:"用户需求原话"}`:记录需求,锁定基线,**签发会话令牌**(返回文本中 `会话令牌:xxxx`,本会话必须保存)。requirement 按「1. 2. 3.」编号分点书写(可多行,一点一件事);**用通俗直白的中文说清「用户能感知到什么变化」,不堆内部类名/参数/样式细节**——详情面板直接把这段话展示给用户。
3. **只在 main/ 内修改**;新建文件也放 main/ 并保持项目原有结构。
4. `vcs_commit {summary:"AI 改动摘要", bump, sessionToken}` 收尾(必须携带 begin 签发的令牌):
   - summary 同样按「1. 2. 3.」编号分点书写,**面向使用者说清"做了什么、用起来有什么不同"**,原样写入 改动日志.md 并按分点渲染;实现细节(类名/参数/样式)不要写进这里
   - bump:`content`=功能迭代(默认)/`polish`=微调/`major`=里程碑或重大重构
   - 自动生成 V 文件夹(更新目的.md + 改动日志.md)、追加工作区日志、git commit + tag
   - 越界文件 / 空 summary / 令牌不匹配 一律被服务端拒绝
   - 工作区有**与本轮需求无关的半成品**时,传 `exclude:["main/...路径"]` 把它排除在本版本之外(原样留在工作区,不入库不丢失);排除后 main/ 一无所剩会被拒绝
5. 一次用户请求至多一个版本;连续 2 版本无进展即停并报告;相同失败 ≥3 次即停。

## 多会话铁律(会话所有权)

- **进行中版本属于签发它的会话**。begin 被拒(另一会话正在进行)时:**不要替它收尾或回滚**,等待其完成,或向用户确认对方已停止后再显式接管。
- 令牌丢失(上下文压缩/新会话接手):`vcs_begin {takeover:"continue"}` 沿用原需求/基线/半成品换发新令牌;`takeover:"fresh"` 把半成品 stash 快照后按新需求开新版本。接管会写审计。
- `vcs_status` 显示"疑似停滞"(30 分钟无活动)仅代表可接管候选,仍需确认对方已停止。
- 回滚遇到进行中版本:传 `resolveInProgress:"stash"` 把半成品快照进 git stash(可找回)后回滚。

## 多工具多项目(统一 MCP 接口)

- 所有 AI 工具连**同一个 MCP 接口**,每个工具用**自己的接入名**区分:HTTP 子路径 `http://127.0.0.1:8471/mcp/<接入名>`,stdio 桥用 env `PVC_CLIENT=<接入名>`。接入名同时是审计与占用显示中的工具身份。
- 用户在桌面端「设置 → AI 工具连接」可为工具**指定默认项目**(路由表):不传 repoPath 时服务端自动路由到绑定项目;显式操作其他项目默认**警告**并写审计,开启「越界拒绝」则直接报错。已绑定的工具请勿随意传别的项目路径。
- **一会话一项目**:同一会话不要跨项目混操作;每个项目的会话令牌独立保存,严禁把 A 项目的令牌传给 B 项目的调用(所有权校验会拒绝)。
- 真实工具名贯穿审计(来源形如 `mcp-http:claude`)、进行中版本、分支记录与 GUI 项目卡片(「哪个项目被哪个工具占用」一目了然)。
- 跨工具并发同项目:沿用并行分支机制(见下节);某工具崩溃占坑超 30 分钟标记疑似停滞,确认停止后可 takeover。
- 分支可**指派管理工具**(assignedClient):被指派工具与令牌持有者、GUI 同为分支属主;跨工具接力在同一分支上工作属正常流程,改派用 `vcs_branch_assign`。

## 回滚与副本管理

- `vcs_rollback {code:"V1.2.0", reason, discardDirty?, resolveInProgress?}`:main/ 回到该版本内容(即"把该版本列为主线",后续版本以此继续),其完整项目副本物化到该版本文件夹/项目副本/。历史永不改写。
- `vcs_delete_copy {code}`:删除已物化的项目副本(不用时清理空间)。版本历史与 tag 不变,内容仍可找回。
- `vcs_restore_copy {code}`:为任意版本生成完整项目副本到 V<版本>/项目副本/(浏览用快照,取自版本历史,不影响 main/ 与 tag;已有副本时先删再建)。

## 并行任务分支(worktree)与触发词

主工作区被其他会话占用而你有新需求时,**不要等待也不要强占**,走并行分支。听到下列话必须行动:

| 用户说 | 你必须做 |
|---|---|
| 创建分支 / 新建分支 / 开个分支并行做 X | `vcs_branch_begin {requirement:需求原话分点, name:短名?, assignee:用户指定的工具接入名?}`;**默认从最新版本节点分叉(base 不传)**,仅当用户明确说「从 V1.10.0 开」这类话才传 base;无论主干是否空闲都会创建真实分支,与 main/ 互不干扰 |
| 在分支 xx 上变更 / 修改 / 开发 | ① `vcs_branches` 找到 xx,记下 `worktreeAbs`(工作树绝对路径);② 所有文件修改只在该工作树目录内,**绝不碰 main/**;③ `vcs_branch_commit {name:"xx", summary}` 做检查点;④ 完成后询问是否 `vcs_branch_merge` |
| 删除分支 / 删减分支 / 不要分支 xx 了 | 先向用户确认(未合并修改不可恢复),再 `vcs_branch_discard {name:"xx"}` |
| 合并分支 xx / 分支收版 | `vcs_branch_merge {name:"xx"}`;返回冲突清单时在 main/ 修复后**再次调用同一工具**完成定版;`abort:true` 放弃 |
| 把分支 xx 交给 XX 工具 / 换 XX 管理 | `vcs_branch_assign {name:"xx", assignee:"接入名"}`;assignee 留空=清除指派 |
| 导入分支 | `vcs_branch_adopt {name, requirement}`:把仓库现存未登记的 vcs/task/* 孤儿分支重建工作树纳入管理;先 vcs_branches 看 orphans 清单 |
| 从 V1.10.0 开个分支 / 从某版本开分支 | `vcs_branch_begin {requirement, name, base:"V1.10.0"}`(base=历史版本号;缺省从当前 HEAD)|
| 分支回退 / 撤销分支最后一次提交 | `vcs_branch_rollback {name:"xx"}`(to=序号或 sha;缺省回退上一检查点;工作树脏时须 force)|
| 把主干最新合到分支 xx / 分支对齐主干 | `vcs_branch_update {name:"xx"}`;分支基点后主干发生过回滚时,先 update 再合并 |

边界:用户只是提到「分支」一词而无操作意图时,不要动作。**分支属主=令牌持有者+指派工具(assignedClient)+GUI 用户**:被指派的工具无需令牌即可 commit/merge/discard;其他非属主工具默认放行但会带「分支属主提醒」(路由 strict 档则拒绝)——不要冒用他人分支。

纪律(V1.28.0 起强制):① **合并冲突挂起期间该分支冻结**——此时提交检查点会被拒绝(挂起后的提交不会进入合并版本,合并完成后还会随工作树删除而丢失);先解决 main/ 内冲突完成定版,或 abort 放弃合并后再继续开发。② **丢弃分支前先存检查点**——工作树有未提交修改时 vcs_branch_discard 默认拒绝(force:true 才放弃);丢弃前给用户确认清楚。③ 分支基点已落库(baseline):分叉后主干发生过回滚时,直接合并会被拒绝并要求显式确认(confirmStaleBase:true),防止把旧基点的变更焊到回滚后的主干上。④ 分支工作树不能当作 repoPath 传给任何 vcs_* 工具(会被拒绝):分支内一律用 vcs_branch_commit/vcs_branch_merge,定版永远发生在主工作区。

通用流程:`vcs_branch_begin` 创建 worktree(返回会话令牌;无论主干是否空闲都创建真实分支)→ **之后所有修改都在该工作树目录内进行,不要动 main/** → `vcs_branch_commit {name, token, summary}` 做检查点(不占 V 版本号;node_modules 不随检出,构建/测试验证在合并后的主工作区统一做)→ `vcs_branch_merge` 合并定版(前置为主工作区已收尾,合并点串行化;冲突挂起后再次调用同一工具完成)→ 不要了用 `vcs_branch_discard`(未合并修改不可恢复,写审计)。`vcs_branches` 查看全部并行分支/待处理 temp/合并冲突状态;**GUI「分支管理」页**同样可新建(可指派工具)/改派/合并/丢弃。

## temp 补救(保底通道)

发现项目被锁、越界无法清理、或其他原因**无法提交**时,把已产生的变化保全下来:

- `vcs_temp_save {summary}`:把 main/ 里已有变化复制到工作区根目录 `temp/<name>/`(含 manifest.json 与 说明.md),main/ 恢复干净,变化不丢。有进行中版本时仅持有者可调用(会同时放弃该任务)。
- 用户确认后:`vcs_temp_apply {name}` 写回 main/(之后走 begin/commit 定版)或 `vcs_temp_discard {name}` 丢弃;GUI「分支管理」页同样可操作。

## 工具一览(25+1)

`vcs_analyze`(分析) `vcs_init` `vcs_begin` `vcs_commit`(支持 exclude) `vcs_status` `vcs_versions` `vcs_read_doc` `vcs_diff` `vcs_rollback` `vcs_delete_copy` `vcs_restore_copy` `vcs_branch_begin` `vcs_branch_commit` `vcs_branch_merge` `vcs_branch_discard` `vcs_branch_assign` `vcs_branch_rollback` `vcs_branch_update` `vcs_branch_adopt` `vcs_branches` `vcs_temp_save` `vcs_temp_apply` `vcs_temp_discard` `vcs_audit` `vcs_migrate`(旧论文库迁移) `vcs_log`。

## 通道

- ZCode 等已注册的 AI 工具:直接调用上述工具。**提交身份**:桥/端点经配置注入(env `PVC_CLIENT=<工具名>`,ZCode 已配)或 CLI 同名环境变量,审计与界面「提交方」按它显示真实工具名;未注入的通道提交会显示「未记录」
- 桌面端 VersionControl Studio:内置 HTTP 端点 `http://127.0.0.1:8471/mcp/<接入名>`(软件开着即可;接入名区分工具,匿名 `/mcp` 兼容可用)
- CLI:在仓库根执行 `node main/core/dist/cli.js <cmd> --dir <工作区>`(亦可写成本机绝对路径;init/begin/commit[--exclude]/status/versions/rollback/analyze/log/read/diff/migrate/delete-copy/restore-copy/branch-begin/branch-commit/branch-assign/branch-rollback/branch-update/branch-adopt/branch-merge/branch-discard/branches/temp-save/temp-apply/temp-discard)

## 版本号

`V{X.Y.Z}`:X=里程碑/重大重构,Y=功能迭代,Z=微调;commit 时按 bump 定版。文档名固定为中文(更新目的.md/改动日志.md/工作区日志.md),不要改名。
