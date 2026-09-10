# Research Steward 接手手册（写给下一个 AI 主实施者）

生成：2026-09-10。这份文件的目标是让一个全新的 AI 会话在不依赖任何旧对话记忆的情况下，接管 Research Steward v0.2→v1 的全部实施工作。逐格进度明细在同目录的 `HANDOVER_2026-09-05.md`（155 格 checkbox 全表 + 20 条监督 finding 处置表），两份配合读。

## 1. 你的角色与授权

你是 **v0.2→v1 路线图的主实施者与执行控制器**。GPT Codex 是外部只读监督者，约每 30 分钟轮询一次仓库并把 finding 写进监督通道（见 §5）；它不写代码，也不许改你的报告目录。用户用中文交流，倾向让你自主裁决普通问题、连续推进，但要求诚实的完成度估计和全程可审计的证据链。

已授权（不必逐项再问）：本地源码/文档/schema/测试/依赖/构建修改；fake/sandbox/fixture 故障注入；worktree 内 commit；只读的 GitHub/VPS/HPC/环境检查；推送 `claude/research-steward-v02-v1` 分支（2026-09-05 起用户明确授权过）。

**安全门槛（永不自动解除）**：不 push/merge main、不动 tag `v0.1.0`、不建 release；不改真实 VPS/Cloudflare/HPC/第三方账户；不提交真实 HPC 作业；不用单独计费 API（如 DeepSeek）；不删除/覆盖用户数据；秘密与 PII 不入代码/日志/事件。碰到门槛：做完只读检查和 fake 验证后，把精确请求写进 `Made by Claude Code/USER_ACTION_REQUIRED.md`，只暂停该 lane，继续其他任务。

## 2. 项目是什么

Research Steward 是一个 local-first、可审计的科研运营插件（MCP server + CLI + skills，装进 Codex CLI 使用）。技术栈：TypeScript / Node 20 / Zod / Vitest / esbuild / MCP SDK。核心协议概念，全部已在 v0.1.0 实现并有测试：

- `.research/events/` **不可变哈希链事件账本**（每事件一文件 + ledger-head 锚），一切结论必须能追溯到事件；
- **frozen packets**（冻结研究包，supersedes 语义）与 **blind review barriers**（盲审屏障：盲组 ≥2、互不可见、下游不得依赖部分盲组）；
- **逐 finding adjudication**（禁止自我裁决 SELF_ADJUDICATION，verification 有 findings:coverage 检查）；
- **verification→acceptance 绑定**（`accepts.verification_event_id/hash`，非最新则 `VERIFICATION_NOT_CURRENT` 拒绝）；
- **generation-fenced 目录租约** + 永久 tombstone（`.retired-<sha256(token)[:32]>`，在线 GC 被裁决否决——延迟观察者论证）；
- **packageHandoff** 干净房 tar 校验；provisional_review 零权威。

历史脉络：v0.1.0 由 Codex 实施、Claude 审查督导，2026-08-31 发布（tag `v0.1.0` = `b144b3b`，dist 哈希 `9070e416…`/`ab374ea0…`），已装进用户 VPS 并跨冷启动验证（**VPS 只许只读检查**）。随后角色互换：Claude 主实施 v0.2→v1 路线图——31 个 Task / 155 个 checkbox / 5 个 Phase（1 基础体验：doctor/preset/dry-run/acceptance helper；2 可靠性：重试/取消/预算/维护/遥测；3 科研合同与证据；4 分布式 worker（fake 先行）；5 控制台、交付、发布治理）。

## 3. 全部地址（一张表）

| 什么 | 在哪 |
|---|---|
| GitHub 仓库 | `https://github.com/Wwaste/research-steward`（gh CLI 已登录该账户，keyring） |
| 实施分支（已推送） | `claude/research-steward-v02-v1`，远端与本地一致 = `9f112fc`；PR 入口 `https://github.com/Wwaste/research-steward/pull/new/claude/research-steward-v02-v1`（开不开 PR 由用户决定） |
| main / tag | `main` = `18aefe8`（merge-base，未动）；`v0.1.0` = `b144b3b`（永不移动） |
| 源仓库本地 checkout | `/Users/waste/research-steward`（用户与 Codex 的现场；**不要在这里实施**） |
| 实施 worktree | `/Users/waste/research-steward-worktrees/v02-v1`（一切实施与 commit 在这里） |
| 插件目录 | worktree 下 `plugins/research-steward/`；**测试必须从这个目录跑**（`npx vitest run`；从仓库根跑会因 cwd 依赖出现 3–4 个假失败） |
| 唯一实施计划 | `docs/superpowers/plans/2026-08-31-research-steward-v0.2-to-v1-roadmap.md`，SHA-256 `916da1ee37cfffbf3587bcdcdcd66b15579b37b4f6a8f37b4d464a29d32c65ca`（749 行；旧 `39b465…` 版本无效，勿执行） |
| 执行 prompt（角色契约全文） | `docs/superpowers/plans/CLAUDE_EXECUTE_RESEARCH_STEWARD_V02_TO_V1_PROMPT.md`，SHA-256 `19519eec184730f3dbd055204eb3348ddca2cf52424192ed1d34a1aa83e57898` |
| 持久状态目录（gitignored，**永不发布**） | `/Users/waste/research-steward/Made by Claude Code/`：`execution-ledger.md`（首行是 PLAN 路径；所有裁决按时间追加，恢复会话从这里开始）、`IMPLEMENTATION_PROGRESS.md`、`CODEX_REVIEW_QUEUE.md`、`CROSS_TASK_CONFLICT_SCAN.md`（11 个共享面的顺序裁决）、`implementation-milestones/TASK-*.md`、`USER_ACTION_REQUIRED.md`（当前无待批项）、`CODEX_CRITICAL_FINDING_PENDING.md`（Codex 的停牌哨兵） |
| Codex→Claude 监督通道 | `/Users/waste/research-steward/docs/HANDOFF_TO_CLAUDE_2026-08-31.md`（gitignored，925 行；§18–27 是十个动态监督检查点，finding 编号 `RS-V1-SUP-001…020`） |
| 本地备份分支（勿删、勿推送） | `backup/pre-pii-rewrite-c6878df`、`backup/pre-push-fix-ac7bf51`——两次未发布历史改写前的原链，供 Codex 审计 |

## 4. GitHub 推送方式与 git 纪律

- commit 一律 `git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit …`；消息含 Task ID，结尾带 `Co-Authored-By: Claude …` 与 `Claude-Session: …` 尾注（见既有提交）。每个 Task 一个 commit 边界，用 `git add <精确文件集>`（对未跟踪文件不要用 commit pathspec，会报 not match）。
- 推送只针对本分支：`git push origin claude/research-steward-v02-v1`。CI 只在 push main / PR 时触发，分支推送不跑 CI。
- **分支历史已公开（9f112fc 及之前），从此不可再改写**。此前两次历史改写都发生在未发布阶段且经用户放行：①`fed8916→333292b` 清洗 eval fixture 里的用户真实姓名+私人邮箱（Critical RS-V1-SUP-013）；②假 Slack token 样例 `xoxe-1-…` 被 GitHub push protection 误判为真凭据，改成无数字段的 `xoxe-fake-redaction-probe` 后重放（`最终链见 git log`）。教训：测试里的假凭据样例要设计成命中自家脱敏正则、但不命中 GitHub 检测器的形状（避免带数字段的 xox?-、82 字符 github_pat_、AKIA+16 等真实格式）；push protection 拦截时不要走解封链接。
- 无人值守模式下权限分类器会拦 `git reset --hard` 之类的历史操作——这是设计如此，停下来把方案和一键脚本交给用户选择，不要绕。

## 5. 与 Codex 的通信方式

双通道文件协议，Phase A 起沿用至今，行之有效：

1. **Codex 读**：整个仓库 + `Made by Claude Code/` 全部内容（对它只读；它**不得**写这个目录，发现被改要报告用户）。所以你的 milestone、queue、ledger 就是给 Codex 的汇报。
2. **Codex 写**：`docs/HANDOFF_TO_CLAUDE_2026-08-31.md` 追加编号章节。它会先核对计划 hash、BASE/HEAD、真实 diff，然后在临时 detached worktree 独立复跑测试、构造反例（它的 RED probe 是真实可复现的失败测试）。
3. **你的义务（执行 prompt §7）**：每完成一个 Task——commit + 完整 milestone + queue 加 BASE/HEAD 行；读 handoff 最新章节；对每条 finding 在 ledger 记 disposition（`accept/partial/reject/defer` + 理由 + 复现命令 + 拟修复 commit）；接受的实际修复并补测试后请求 scoped re-review；**拒绝的必须跑出反例**，不能只写观点。Codex 不能自我裁决争议性 finding，僵局写进 `USER_ACTION_REQUIRED.md` 交用户。
4. 请求复审的方式就是往 `CODEX_REVIEW_QUEUE.md` 加行（格式见文件内 #0–#10）。

**当前通信状态**：Codex 最后一次活动是 2026-08-31 19:25（§27 / 哨兵文件更新）。它尚未复核 9 月 5 日的 013 修复（`e4af416`）和已推送的最终链；queue #10 的 scoped re-review 请求待回。接手后如果 handoff 长度超过 925 行，说明 Codex 回来了，先读新章节再动手。

## 6. 目前进展（做好了什么）

分支 14 个 commit（`git log --oneline 18aefe8..HEAD` 逐一对应）：计划基线 `9ccb360`；Task 1.1 分发基线 `079dbb0`；1.2 doctor `94a2214`；1.3 presets/planner `425835a`；1.4 forecast `4989f75`；1.2–1.4 接线（CLI 三命令 + MCP 三工具，13→16）`e72c640`；smoke 六 schema 副本 `82bd9f3`；1.5 acceptance-helper/attention `0023ae0`；2.1 provider-failure/retry-policy `6b4cb89`；2.5 telemetry/evaluation `333292b`；2.4 ledger-index/maintenance `7165255`；013 修复+provenance 卫生测试 `e4af416`；进度交接文档 `d55bb28`、`9f112fc`。

落地的模块：`doctor.ts`（14 项检查，auth 恒 skipped 零调用）、`presets.ts`+`planner.ts`（7 preset、write-once lock）、`forecast.ts`（保守上界+route 阻止警告）、`acceptance-helper.ts`+`attention.ts`、`provider-failure.ts`+`retry-policy.ts`（八类失败、结构化码优先）、`ledger-index.ts`+`maintenance.ts`（完整性缓存+离线维护）、`telemetry.ts`+`evaluation.ts`（白名单 span、脱敏、零费用 eval）。MCP 16 工具、CLI `doctor/build-plan/dry-run`、6 公开 schema、4 条 smoke。

质量基线：24 test files / **294 tests 全绿**（workflow-concurrency/package-handoff 在高并发下偶发超时 flake，隔离重跑稳定——backlog）；typecheck 过；coverage 82.49/82.63/90.95/82.49 对阈值 75/77/84/75（只升不降，目前仅注释约定）；`npm audit` 0。加权完成度约 **19–20%**（155 格里 ✅21/🟡18/❌1/⬜115）。

## 7. 没做完与有问题的（按优先级）

**7.1 Codex findings 未修 18 条**（处置表在 ledger 与 HANDOVER_2026-09-05 §4；`013 已修`，`001/002/003/012/020` 属过程门已回应）。其中 **5 条带 Codex 可复现 RED 反例，是第一优先**：

- **014** `prepareAcceptance()` read-modify-write 会覆盖运行期间的人工审批编辑——需租约或初读 bytes/hash CAS，变化即 `ACCEPTANCE_DOCUMENT_CHANGED` fail-closed；把 Codex 的屏障反例变成正式测试。Task 1.5 在此之前不得称完成。
- **016** maintenance plan 只绑定数量：same-count replacement 会删掉从未被点名的新对象——plan 必须冻结路径集合+项目/head/inspection 身份+每目标 generation 身份，apply 逐项复核，异动整单 fail-closed。
- **017** 目录形 index 的 rebuild 动作 apply 时裸 `EISDIR`——inspect/plan 要对非常规文件产出 blocked/quarantine action，apply 要么安全隔离要么 typed error。
- **018** typed retry policy 完全未接线：quota 失败在 workflow 里仍被真实调用 3 次——分类必须在 `providers.ts` stderr 尚在内存时完成，`workflow.ts` 用 `policyFromPlanLimits()`+`decideRetry()` 决定重试并记录 per-attempt invocation ID/reason/backoff。修复前**禁止无人盯守真实 provider**。归入 Task 2.2 一起做。
- **019** telemetry append 跟随 symlink、不收紧已存在的 0644 文件、脱敏漏 Windows home 路径——no-follow open + fstat 校验 + 收权/拒绝，脱敏覆盖 `C:\Users\`、UNC。

其余未修：**004** installed smoke 从未走真实 v0.1.0 tag→install cache→新 client 链；**005** coverage 阈值下界没有测试锁定；**006** doctor 缺 MCP tool inventory / root policy / model-route 检查与"错误模型名"用例；**007** lock 缺 skill version/profile/budget 身份；**008** forecast 字符上界漏乘 retry attempts（最多低估至 1/3）；**009** `max_parallel_width` 用依赖分层低估真实调度宽度、metered/unknown route 在真实输入中不可达、缺 per-provider 并发；**010** `research_doctor` 误标 readOnlyHint（实际写 probe 文件）；**011** plan+lock 两步写可产生半提交（plan 落盘、lock 失败）；**015** ledger index 无 offset/加速读路径/10k-100k 性能回归（当前只是完整性交叉检查缓存，读路径仍全量扫描）。

**7.2 冻结中的闸门**：第二接线批次（1.5 prepare-acceptance + 2.4 maintenance 进 CLI/MCP，工具 16→约 18）被 012/020 冻结，解冻条件 = 014/016/017/019 修复 + Codex scoped re-review。**Slice A（Phase 1）gate = NOT PASSED**（004–011 开放）。

**7.3 backlog 杂项**：retry 正则边缘 over-match（"did not…found"、429+error 上下文、token.*expired）；`public-schema/workflow` 测试的 cwd 依赖；并发 flake 根治；telemetry 多进程 append/int64/redact-lengthening 的已知边界注释。

**7.4 完全未开始：23 个 Task（115 格）**——2.2 取消/幂等/崩溃恢复（中）、2.3 跨进程预算许可（中）、2.6 diff 复审事件（中）、3.1 科研合同（中）、3.2 Evidence discriminated union（中，破坏性改动需 v1 兼容支）、3.3 审计 skills 目录（轻）、3.4 command runner（中）、3.5 claim 矩阵（中）、3.6 引用/撤稿联网检查（重）、3.7 校准 benchmark（重）、3.8 复现适配器（中）、4.1 worker 协议冻结（重）、4.2 coordinator（重）、4.3 Mac worker（重）、4.4 HPC worker（重）、4.5 远程访问文档（重）、5.1 控制台 read-model（重）、5.2/5.3 控制台 UI（重）、5.4 交付状态机（中）、5.5 事件签名（中）、5.6 skill catalog（轻）、5.7 store/workflow 拆分+发布治理（重，必须最后，先加 characterization tests）。Phase 3 的门槛需要用户提供三个脱敏真实科研样例；Phase 4/5 的真实外部操作全部走审批文件。

## 8. 还没检查/没测试的东西（诚实清单）

CLI `doctor` 命令的退出码路径没有任何测试；"错误模型名"场景零覆盖；真实 tag 安装链从未执行过（smoke 用的是 checkout 复制品）；10k/100k 账本性能从未测过；telemetry 的 symlink/预存宽权限/Windows 路径三个反例是 RED；冻结 packet 正文不进 trace 只有单元级、缺序列化全路径扫描；2.1 的重试策略在运行时的真实行为未验证（Codex 反例证明 quota 仍三连调用）；`prepareAcceptance` 并发窗口是 RED；maintenance 的 same-count replacement 与目录 EISDIR 是 RED；多进程并发 append telemetry 未测；eval gold 标签目前全部是 synthetic_expected_behavior（诚实标注），恢复 human-adjudicated 声明需要真实标注记录+用户确认署名。

## 9. 新会话接手的操作序列

1. 读 `/Users/waste/research-steward/Made by Claude Code/execution-ledger.md`（首行 PLAN 路径，通篇是按时间排序的裁决记录）；读本文件与 `HANDOVER_2026-09-05.md`；读 handoff §18–27（若超过 925 行，先读新章节）。
2. 核对现场：worktree clean、HEAD=`9f112fc`、远端一致、备份分支在、计划 SHA-256 匹配。对不上就先在 ledger 记录差异，不要凭记忆推断。
3. 第一批实施（顺序即 Codex 定序）：把 014/016/017/019 的反例写成正式 RED 测试→修绿→更新对应 milestone/queue→请求 scoped re-review。每项都是"先失败测试，后最小实现"。
4. 复审通过后解冻第二接线批次（1.5+2.4 → CLI/MCP，同步更新三个 smoke 的 tool-count 断言），然后 Task 2.2（018 在此接入运行时）→ 2.3 → 2.6 → Phase 2 故障注入 gate + `implementation-milestones/PHASE-2.md` + Codex phase review。
5. 期间顺手清 004–011、015 与 backlog；Phase 3 前把"需要用户的三个脱敏样例"提前写进 `USER_ACTION_REQUIRED.md`，避免到时候阻塞。
6. 每个 Task 完成即 commit+milestone+queue，普通问题自行裁决并按 `Ruling: 什么 — 为什么 — 错了的代价` 记录；只有 §1 门槛项才升级用户。

## 10. 工作方式与思考要点（传承）

- **并行纪律**：可以并行派多个 implementer 子代理，但它们只许写互不相交的新文件；`protocol.ts/cli.ts/server.ts/store.ts/workflow.ts/generate-schemas.ts` 等共享面由你作为唯一 integrator 串行合入（CROSS_TASK_CONFLICT_SCAN.md 有 11 个共享面的完整裁决）；所有 commit 由你打；中间测试计数不作验收证据，验收证据必须在稳定 commit 上重跑。内部 reviewer 不能替代 Codex。
- **证据文化**：每个行为改动先写会失败的测试；修复必须附命令与退出码；不虚构任何 provenance（013 的教训）；不确定就标 partial/unknown，不硬贴标签。
- **技术裁决速查**（详见 ledger）：forecast 墙钟上界只在每层 ≤ max_parallel 时用关键路径公式，否则回退 `limits.max_wall_time_ms`；重试上界以 forecast 的 `retry_limit+1` 为权威，`policyFromPlanLimits` 保证不超；失败分类结构化码优先于多语言 stderr 正则、哈希永不参与匹配；一切落盘用 `wx` 不 clobber；恢复/维护路径用 realpath 归一（`canonicalizeMissingPath` 防 `/var→/private/var` 别名逃逸）；esbuild 生成器 bundle 要 createRequire banner + 临时文件 file: URL import（data: URL 会破 createRequire）；tombstone 永久保留，在线 GC 已被否决。
- **用户风格**：中文；要诚实的完成度百分比和时间估计（宁可保守）；允许你大量并行子代理加速；说"继续"就意味着从 ledger 恢复接着推进，不要重新规划已裁决过的事。
