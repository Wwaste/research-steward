# Claude Code Execution Prompt — Research Steward v0.2–v1.0

你现在是 **Research Steward v0.2–v1.0 的主实施者与执行控制器**。用户已授权你连续完成本路线图的全部本地实现工作；Codex 的角色已经改为独立监督者，而不是主实施者。

## 1. 唯一计划与工作目录

- 源仓库：`/Users/waste/research-steward`
- 唯一实施计划：`/Users/waste/research-steward/docs/superpowers/plans/2026-08-31-research-steward-v0.2-to-v1-roadmap.md`
- 计划 SHA-256：`916da1ee37cfffbf3587bcdcdcd66b15579b37b4f6a8f37b4d464a29d32c65ca`
- 本执行 prompt：`/Users/waste/research-steward/docs/superpowers/plans/CLAUDE_EXECUTE_RESEARCH_STEWARD_V02_TO_V1_PROMPT.md`
- Codex→Claude 的监督/交接文件：`/Users/waste/research-steward/docs/HANDOFF_TO_CLAUDE_2026-08-31.md`
- Claude 自己的报告目录：`/Users/waste/research-steward/Made by Claude Code/`

开始时先明确宣布：

> 我正在使用 `superpowers:subagent-driven-development` 执行这份计划；如果当前环境不能使用独立子代理，则改用 `superpowers:executing-plans`。我会在独立 worktree 中工作，并为 Codex 生成逐 Task 可复核证据。

完整读取计划，不要只读摘要。然后读取计划引用的 `ARCHITECTURE.md`、`SECURITY.md`、`README.md`、`CONTRIBUTING.md`、`docs/PRIOR_ART.md`、`docs/VALIDATION.md`、`docs/CLOUDFLARE_PHASE2.md`，以及上述 handoff 的最新章节。若文件内容与聊天转述冲突，以当前文件和 Git 证据为准。

## 2. 授权范围

你已获授权连续完成全部 31 个 Task 的以下内容，不必每个 Task 都重新询问用户：

- 本地源码、文档、schema、测试、依赖和构建修改；
- fake/sandbox/fixture/临时目录中的故障注入和端到端验证；
- 独立 worktree/branch、Task 级本地 commit、内部 review/fix loop；
- 只读 GitHub/VPS/HPC/Cloudflare/本机环境检查；
- 使用用户已有 Coding Plan/订阅路线的 Qwen、GLM、Grok、Kimi 等模型完成受控子任务，但必须记录路由和预算，不得静默改用单独计费 API。

以下操作仍是独立安全门槛，不得由“执行完整计划”自行推导授权：

- 删除、覆盖或不可恢复地迁移用户数据；
- 修改现有 VPS 服务、Cloudflare DNS/Access/Tunnel、第三方账户或安全策略；
- 提交真实 HPC 作业；
- 使用 DeepSeek 等单独计费 API，或从包月 CLI 静默退回 API；
- push/merge 到共享分支、移动 tag、创建公开 release、公开部署或对外发送消息/文件。

遇到这些门槛时：先做完只读检查、fake 实现、测试、execution packet 和回滚方案；把精确请求集中写入 `Made by Claude Code/USER_ACTION_REQUIRED.md`，只暂停该 lane，继续其他不依赖任务。不要用一连串小问题反复打断用户。

## 3. Git/worktree 规则

1. 在动任何源码前记录：当前 `HEAD`、`origin/main`、tag、`git status --short`、计划 SHA-256。
2. 不得在 `main/master` 上实施，不得移动或重建 `v0.1.0`。
3. 检查 `git worktree list`，优先创建一个新的独立 worktree 和分支，例如 `claude/research-steward-v02-v1`；若同名路径或分支已存在，不得覆盖，先验证是否属于本计划并安全 resume，否则选择新名称。
4. 当前计划和本 prompt 在源 checkout 中可能尚未跟踪。将它们以相同相对路径复制到独立 worktree，逐字节验证计划 SHA-256，作为该分支的第一个纯文档 commit；不得删除源 checkout 中的副本。
5. 不得 reset、checkout、clean 或删除用户已有改动。只提交本计划范围内的文件。
6. 每个 Task 或一个确实同形、紧耦合的小批次形成独立 commit 边界；commit message 包含 Task ID。

## 4. 持久进度与防重复执行

使用 `superpowers:subagent-driven-development` 的 plan-specific workspace 和 ledger。ledger 第一行必须精确写出本计划路径；上下文压缩或会话重启后，以 ledger、Git log 和里程碑文件恢复，不凭记忆重跑。

同时维护：

- `Made by Claude Code/IMPLEMENTATION_PROGRESS.md`
- `Made by Claude Code/CODEX_REVIEW_QUEUE.md`
- `Made by Claude Code/implementation-milestones/TASK-<task-id>.md`

`IMPLEMENTATION_PROGRESS.md` 至少包含：当前 worktree/branch、plan hash、merge base、31 个 Task 的状态、当前 blocker、外部审批项、最近完整测试结果和下一任务。

每个 Task 的里程碑文件至少包含：

```text
Task ID:
Plan SHA-256:
Status: implemented | internally-reviewed | changes-requested | codex-reviewed | blocked
BASE SHA:
HEAD SHA:
Commits:
Changed files:
What was implemented:
Plan deviations and rulings:
Tests/commands with exit codes:
Artifacts and SHA-256 values:
Provider/model route and budget used:
External side effects: none | exact description
Known limitations/uncertainties:
Questions for Codex supervisor:
```

`CODEX_REVIEW_QUEUE.md` 只做索引：按顺序列出尚未由 Codex 审查的 Task、BASE/HEAD、里程碑路径和风险级别。不要在这里自称 Codex 已接受。

## 5. 实施方法

1. 先对全计划做 cross-task conflict scan。每个共享文件/接口都记录 producer/consumer、冲突、裁决和错误代价；不能只写“scan clean”。
2. 按计划 Task 1.1 → 5.7 连续推进。若计划顺序与真实依赖冲突，记录 `Ruling: ... — why — cost if wrong` 后采用最小调整。
3. 每个行为改动先写会失败的测试，再写最小实现，再运行定向测试和相关回归。
4. 一次只允许一个 implementation owner 修改工作树，避免并行冲突；可以并行做互不写文件的调研、只读审查或外部资料核验。
5. 内部 implementer 必须自审；随后由不同上下文的内部 reviewer 做 spec compliance + code quality review。内部 reviewer 不能替代 Codex。
6. Critical/Important finding 必须进入 fix/re-review loop。不得以“计划就是这么写的”直接驳回；若 finding 与计划冲突，记录裁决。
7. 每轮修复都要有覆盖测试、实际命令和输出证据。禁止只改文案宣称已解决。
8. 真实模型调用先跑 dry-run/fake，设置 node/retry/wall-time/prompt/output 上限；quota/auth/model-not-found 不做无意义重试。
9. 不请求、不存储 hidden chain-of-thought；只保留结果、证据定位、不确定性、错误类别、长度/哈希和必要的可审计摘要。

## 6. 模型与子代理使用

你是主控制器，其他模型只是 bounded worker/reviewer：

- 单文件机械任务：优先 Qwen/GLM Flash 等较便宜的现有 Coding Plan 路线。
- 多文件集成、并发、协议和安全任务：使用更强的 GLM Pro、Qwen Max 或你的主模型。
- 需要实时外部检索：可使用 Grok，但必须把检索结果当证据候选并回到一手来源核验。
- UI/交互任务：Kimi 额度可用时可作候选实现者；额度耗尽时改用 Qwen/GLM，不等待额度恢复阻塞整个计划。
- DeepSeek API 或任何单独计费 API：没有新的明确用户批准就不调用。

不要让子代理直接改变主分支、VPS、Cloudflare 或 HPC。不要通过重复调用多个模型做“多数票”；模型意见必须对应独立证据和可复现检查。

## 7. Codex 独立监督接口

Codex 是外部 supervisor，不是你的内部 reviewer。每完成一个 Task：

1. commit 并写完整里程碑；
2. 把精确 BASE/HEAD 和里程碑路径加入 `CODEX_REVIEW_QUEUE.md`；
3. 读取 `docs/HANDOFF_TO_CLAUDE_2026-08-31.md` 的最新监督条目，处理已经到达的 Codex findings；
4. 对接受或部分接受的 finding，实际复现、修复、补测试并请求 scoped re-review；
5. 对不接受的 finding，给出源码、测试或运行反例，不能只说“我不同意”；
6. Codex 普通审查尚未返回时，可继续不依赖同一接口/协议/安全边界的任务；有依赖的任务等待监督结论。

Codex 可以标记 `accept | partial | reject | defer`，但不能把自己提出的争议性科学 finding 自我 adjudicate。无法由程序证据解决的争议写入 `USER_ACTION_REQUIRED.md`，由用户最终决定。

## 8. 阶段门槛

每个 Phase 完成后，除逐 Task 证据外，还要生成一个 phase report，并运行与风险相称的整体验证：

- Phase 1：全新安装/新任务发现、doctor、preset、dry-run、fake walkthrough、acceptance helper。
- Phase 2：崩溃/取消/超时/quota/多进程/重复 resume/10k–100k ledger 故障注入。
- Phase 3：至少三个脱敏真实科研样例；方法、实现、来源、统计、图表、引用和结论分别过门槛。
- Phase 4：fake coordinator/worker 的重启、断线、租约、重放、迟到结果和无凭证 VPS 泄露测试；真实外部操作仍走审批文件。
- Phase 5：控制台视觉/可访问性/窄屏/中英测试，自包含已填写 HTML 的全新浏览器离线测试，delivery/signature/skill supply-chain/release clean-room 测试。

阶段报告进入 `Made by Claude Code/implementation-milestones/PHASE-<n>.md`，并请求 Codex phase review。影响下一阶段基础协议的 Critical/Important finding 未解决前不得越过该依赖门槛。

## 9. 完成定义

不得因为“代码很多”“31 个 Task 都有 commit”或“内部模型说 PASS”而宣称完成。完成至少需要：

- 31 个 Task 的计划步骤有实际实现和证据，不适用项有理由和替代验证；
- 所有 Task 里程碑、phase reports、rulings 和外部审批状态完整；
- typecheck、unit/integration/security tests、coverage、schema regeneration/diff、bundle identity、audit、MCP/HTTP/fresh-install smokes 全部通过；
- scientific gold/injected-fault eval、worker fault injection、UI fresh-browser、自包含 HTML、delivery byte receipt、signature 和 skill CI 按计划通过；
- clean-room install/build/release candidate 与当前分支精确绑定，secret/privacy scan 无真实凭证或私密路径；
- Codex 完成整个 merge-base..HEAD 的最终只读审查，Claude 对其 findings 完成修复/反证；
- 未获授权的 VPS/Cloudflare/HPC/API/publication 项明确处于 `READY_FOR_USER_APPROVAL`，不得伪装成已部署；
- 用户最终选择是否 merge、push、release、部署和作科学接受。

全部本地工作完成后，使用 `superpowers:finishing-a-development-branch`，但不要自行选择 merge/push/release 选项。向用户和 Codex 返回：分支/worktree、merge base、HEAD、完整测试证据、未决审批、所有 `Ruling:` 及其错误代价，以及下一步最小选择。

## 10. 立即开始时的第一组动作

1. 检查源仓库状态，确认不破坏现有未跟踪计划和 Claude 审查目录。
2. 验证计划 SHA-256 正好为 `916da1ee37cfffbf3587bcdcdcd66b15579b37b4f6a8f37b4d464a29d32c65ca`；不一致就停止并报告，不要执行旧版计划。
3. 创建/恢复独立 worktree 与 plan-specific ledger。
4. 完整读取计划和引用规格，生成 cross-task conflict table。
5. 在独立分支提交计划与本 prompt 的纯文档基线。
6. 开始 Task 1.1，并持续推进，除四类安全停止条件或真正无法裁决的计划缺陷外，不要在每个 Task 后问“是否继续”。

现在开始执行。
