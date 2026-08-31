# Research Steward v0.2–v1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Research Steward 从已发布的本地审计协议 v0.1.0，逐步扩展为低摩擦、低成本、科研严谨、可分布式运行且具有清晰控制台的“科研管家”；整个扩展过程保持文件权威、不可变事件、独立证据通道、非投票裁决和具名人工接受。

**Architecture:** 保留现有 TypeScript 插件、CLI、MCP、冻结数据包与哈希链事件账本作为内核。新增能力优先通过小型模块、明确协议版本和只读投影视图接入；VPS 只做协调，模型凭证留在本地工作节点；科学判断与确定性程序门槛分离。LangGraph、Temporal、Agent Framework 等只作为设计参照，不替换现有协议内核。

**Tech Stack:** Node.js 20+/TypeScript/Zod/Vitest/MCP SDK；后续控制台候选为 React + Vite + `@xyflow/react`；可选 Python 科研适配器通过受限命令执行器调用；部署保持 systemd + Tailscale 优先，Cloudflare Access/Tunnel 仅在单独授权后进入第二远程阶段。

**Spec:** 本文件同时是冻结的产品规格、外部项目借鉴记录和主实施路线图；v0.1 不变量以 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)、[`SECURITY.md`](../../../SECURITY.md)、[`docs/PRIOR_ART.md`](../../PRIOR_ART.md) 与 [`docs/CLOUDFLARE_PHASE2.md`](../../CLOUDFLARE_PHASE2.md) 为准。

**Execution Owner:** Claude Code 是主实施者和执行控制器；它负责 worktree、任务调度、源码、测试、提交、内部审查循环和里程碑证据。

**Independent Supervisor:** Codex 是外部监督者；它只读审查 Claude 的精确 diff、复跑高风险验证、登记 findings，并对修复是否有证据作 `accept | partial | reject | defer` 监督裁决。Codex 不在审查期间直接修 Claude 的分支。

**Final Authority:** 用户是产品、科研和外部系统的最终权威；争议性科学结论、公开发布、不可逆/安全敏感操作和无法由测试裁决的 findings 由用户决定。

## Global Constraints

- **当前状态：AUTHORIZED FOR CLAUDE EXECUTION。** 用户已明确要求 Claude Code 把本路线图执行完；Claude 可连续完成全部本地源码、文档、依赖、测试、fake/sandbox 验证和独立 worktree 提交，不必在每个 Task 后重新请求启动许可。
- 授权不取消下列独立安全门槛：不可逆/破坏性操作、安全敏感操作、公开 push/merge/release、真实 Cloudflare DNS/Access/Tunnel 变更、第三方账户连接、单独计费 API、真实 HPC 提交或会影响现有 VPS 服务的变更，必须先留下精确 execution packet、回滚方案和用户确认；等待确认时继续其他独立任务。
- 不以模型多数票代替证据裁决；同一模型的多个角色不算独立证据源。
- 人工科学接受、确定性验证、打包和交付继续是不同门槛；低权限 provisional review 不能提升权限。
- 不自动发现账户或凭证，不从包月 CLI 静默退回单独计费 API，不把秘密写入计划、事件、日志或仓库。
- 默认私有、本地优先。原始提示、冻结科研材料和模型输出不得默认上传到托管可观测平台。
- 外部代码进入仓库前必须完成许可证、来源、维护状态和安全审查；“借鉴功能”默认表示独立实现，不表示复制代码。
- 所有协议变更必须有版本化 schema、迁移/拒绝策略、公开 schema 重建和旧项目回归测试。
- 所有交互式 HTML 审批表必须能够导出单文件自包含的 `已填写版 HTML`，在全新浏览器上下文中仍可查看、继续编辑和再次导出，不依赖 `localStorage` 或伴随文件。
- Apocrita 路径只允许 `--partition=computeshort`、单任务不超过 1 小时、可拆任务用数组、总并发不超过 480 核，QoS 仅使用 `normal` 或 `ood`。
- 每个阶段结束都必须经过：单元/集成/安全测试、公开 schema 与 bundle 一致性、隐私扫描、独立复核、逐项 accept/partial/reject 裁决和版本绑定的发布证据。

## Execution Roles and Supervision Protocol

### 固定身份

| 身份 | Actor ID | 责任 | 禁止事项 |
|---|---|---|---|
| Claude Code | `claude-implementer` | 主实施、内部任务调度、测试、提交、自审、修复 Codex findings | 不得把自己的输出标成独立接受；不得在未授权时修改外部系统 |
| Codex | `codex-supervisor` | 只读 diff 审查、独立复现、风险分级、修复验证、阶段监督报告 | 审查期间不直接改 Claude 分支；不得把自己的 finding 当作独立科学裁决 |
| Deterministic verifier | `research-steward-verifier` | tests/schema/hash/bundle/security/receipt 等机器门槛 | 不得声称程序 PASS 等于科学结论成立 |
| 用户 | `user-scientific-authority` | 争议 finding、科学接受、公开发布和高风险外部操作的最终决定 | 不适用 |

### 工作流

```text
user authorization
  -> Claude implements in isolated worktree
  -> Claude tests, self-reviews, commits, writes milestone packet
  -> Codex independently reviews exact BASE..HEAD and targeted runtime evidence
  -> Claude reproduces and fixes accepted/partial findings
  -> Codex verifies remediation or records unresolved dispute
  -> deterministic full-branch gates
  -> user decides promotion / external deployment / scientific acceptance
```

- Claude 可使用 `superpowers:subagent-driven-development` 做内部逐 Task 实施和审查，但这些内部 reviewer 不能替代 `codex-supervisor`。
- Claude 必须在独立 worktree/branch 工作；不得直接在 `main` 或移动 `v0.1.0` tag。每个 Task 或紧耦合的小批次必须有可审查 commit 边界。
- Claude 每完成一个 Task，就在 `Made by Claude Code/implementation-milestones/` 写里程碑文件，并更新 `Made by Claude Code/IMPLEMENTATION_PROGRESS.md` 与 `CODEX_REVIEW_QUEUE.md`。
- 每个里程碑至少记录：Task ID、plan SHA-256、BASE/HEAD、commit、改动文件、需求偏离、测试命令与退出结果、生成 artifact/hash、外部副作用、模型/额度路线、已知不确定性和待 Codex 检查项。
- Codex 对 Claude 的 finding 不能由 Codex 自己完成正式科学 adjudication。Claude 可用代码/测试反驳或修复；仍有争议时由用户或另一个明确授权的独立 adjudicator 裁决。
- Claude 不因等待 Codex 普通审查而停止所有工作：可继续不依赖该 finding 的任务；涉及同一接口、协议版本、安全边界或后续依赖的 Task 必须等待监督结论。
- 只有 Codex 阶段报告写明“review gate passed”、所有确定性门槛通过且用户批准 promotion，才可 merge、公开发布或部署。

---

## 0. 当前基线与优先级规则

### 已有基线

- v0.1.0 已具备：项目初始化、冻结数据包、不可变事件、开放/盲审 DAG、逐项 adjudication、确定性验证、具名接受、打包、13 个 MCP 工具、CLI/stdio/HTTP 路径和 Tailscale/VPS 部署模板。
- 当前权威仍是 `.research/events/` 与 `.research/frozen/`；Markdown 页面是投影视图，不是共享写入区。
- 当前已知摩擦包括：缺少统一 preflight doctor、计划模板需要手写、没有 dry-run 成本预览、接受文件需手工复制验证 ID/hash、取消与跨进程配额不完整、证据定位器过于自由、控制台缺失、长账本需要索引/维护方案。
- 在执行任何新功能前，先修复当前文档/分发小问题：稳定安装应固定 release tag、README 不应继续称为 release candidate、coverage 命令需要真实 provider 依赖、需要从全新 Codex 任务验证插件发现链。

### 排序方法

每项工作按以下四维评分，但不把分数当自动决策：

1. **时间回收**：是否减少重复配置、等待、复制和人工盯守。
2. **科学风险下降**：是否降低错误结论、证据错配、数据泄漏或不可复现风险。
3. **协议兼容性**：是否能增量加入而不破坏 v0.1 的权威边界。
4. **实现/运维负担**：是否会引入长期服务、复杂依赖或新的秘密管理面。

P0 表示下一次获准开发时优先；P1 表示完成前置门槛后实施；P2 表示有明确价值但需真实使用数据或部署条件证明必要。

---

## 1. GitHub 现状扫描与吸收决策

星标为 2026-08-31 的近似快照，会变化；星标只表示关注度，不是科研质量或安全证明。

### 1.1 Skill 与科研工作流

| 项目 | 快照 | 可借鉴能力 | 决策 |
|---|---:|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | ~279.9k★，MIT | 规格先行、TDD、分阶段复核、子代理开发纪律 | 借鉴开发流程；不作为运行时依赖 |
| [anthropics/skills](https://github.com/anthropics/skills) | ~172.7k★，混合授权 | `SKILL.md` 自包含结构、渐进披露、复杂 skill 的资源组织 | 兼容结构；逐目录审许可证，source-available 文档 skills 不复制 |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) | ~24.9k★，Apache-2.0 | 开放 Agent Skills 格式、渐进披露、跨客户端可移植性 | 作为 skill 兼容性基线 |
| [sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills) | ~45.7k★，MIT | 本地目录、选择证据、可复现 skill stack manifest、stack diff | 吸收“skill lockfile + 选择证据”；不自动安装全库 |
| [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | ~40.4k★，MIT | 大型科研 skill 目录、security/skill CI、数据库与方法工具覆盖 | 选择性适配，禁止整库无审计导入 |
| [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | ~44.4k★，CC BY-NC 4.0 | 人在回路、claim locator、校准集、FNR/FPR、revision trajectory、完整性门槛 | 只借鉴公开概念；不复制 NC 内容到 Apache-2.0 项目 |
| [wanshuiyin/Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) | ~15.5k★，MIT | 跨模型审查、实验队列、订阅型 Codex MCP、characterization tests、预算与输出折叠 | 借鉴队列/路由/回归方法；拒绝无界自主循环 |
| [Orchestra-Research/AI-Research-SKILLs](https://github.com/Orchestra-Research/AI-Research-SKILLs) | ~12.2k★，MIT | 两层研究编排、实验工程技能、真实故障排查资料 | 作为技能覆盖缺口表，不直接引入总编排器 |
| [ai4s-research/ai4s-skills](https://github.com/ai4s-research/ai4s-skills) | ~200★，MIT | 可追溯结果、实验包、图像/数值/逻辑完整性审计、四级证据 | 吸收输出契约与完整性审计思想 |
| [Yuuqq/research-grade-skills](https://github.com/Yuuqq/research-grade-skills) | 新项目，MIT | frontmatter/注册表/相对链接/脚本语法/外链失效/供应商引导 CI | 星标低但工程信号强；吸收质量门槛 |
| [InternScience/Awesome-Scientific-Skills](https://github.com/InternScience/Awesome-Scientific-Skills) | ~527★，MIT | science-first 目录、skill metric、composition recipes | 吸收目录评分与科研阶段组合配方 |

### 1.2 编排、耐久性和模型质量

| 项目 | 快照 | 可借鉴能力 | 决策 |
|---|---:|---|---|
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | ~40.8k★，MIT | durable execution、checkpoint、interrupt/HITL、恢复与状态投影 | 借鉴 checkpoint/interrupt 语义；不替换文件账本 |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | ~13.2k★，MIT | 顺序/并行/交接/群组图、checkpoint、time travel、A2A/MCP | 借鉴能力协商和图执行测试；暂不引入框架 |
| [microsoft/autogen](https://github.com/microsoft/autogen) | ~60.7k★，maintenance mode | 早期多代理模式 | 明确不作为新依赖；微软已建议新项目使用 Agent Framework |
| [temporalio/temporal](https://github.com/temporalio/temporal) | ~22.7k★，MIT | 幂等 Activity、持久工作流、失败恢复、worker pull | 借鉴远程 worker lease/idempotency；当前规模不引入服务 |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | ~81.2k★，MIT | 设置向导、sandbox、subagent 上限、memory、trace、长任务 gateway | 借鉴 onboarding、能力上限和隔离提示；不采用通用 super-agent 内核 |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | ~34.0k★，GitHub 未识别 SPDX | trace、dataset、eval、prompt version、成本/延迟、人工标签 | 借鉴本地可观测模型；许可证复核前不 vendoring，默认不上传数据 |
| [mlflow/mlflow](https://github.com/mlflow/mlflow) | ~27.7k★，Apache-2.0 | OpenTelemetry trace、评估集、prompt lineage、实验比较 | 提供可选导出适配器，不成为 v0.2 强依赖 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | ~24.7k★，MIT | 本地 prompt/model 对比、断言、红队、CI 回归 | 候选 dev-only 评估工具；先用内部固定数据集验证适配价值 |

### 1.3 科研证据、复现和界面

| 项目 | 快照 | 可借鉴能力 | 决策 |
|---|---:|---|---|
| [Future-House/paper-qa](https://github.com/Future-House/paper-qa) | ~9.1k★，Apache-2.0 | 本地科学文档 RAG、引用、Crossref 元数据、期刊质量与撤稿状态 | 设计 citation connector；必须保留原文定位和检索时间 |
| [stanford-oval/storm](https://github.com/stanford-oval/storm) | ~31.2k★，MIT | 多视角提问、source-grounded outline、Co-STORM moderator、动态 mind map | 吸收“覆盖地图/问题树”，不采用自由群聊作为权威 |
| [treeverse/dvc](https://github.com/treeverse/dvc) | ~15.9k★，Apache-2.0 | 数据/参数/管线/实验版本与复现 | 可选项目适配器；Research Steward 记录 DVC identity，不复制数据 |
| [fivetran/great_expectations](https://github.com/great-expectations/great_expectations) | ~11.8k★，Apache-2.0 | 声明式数据质量 expectations 与验证结果 | 作为确定性检查 profile 的可选执行器 |
| [marimo-team/marimo](https://github.com/marimo-team/marimo) | ~22.6k★，Apache-2.0 | 无隐藏状态的响应式 notebook、纯 Python、可测试/可部署 | 推荐为新分析的可选 notebook 模式，不强迫迁移现有 Jupyter |
| [quarto-dev/quarto-cli](https://github.com/quarto-dev/quarto-cli) | ~6.0k★，需逐文件审查 | 代码、结果、文本一体的科研出版与多格式输出 | 可选报告/仪表板出口，保持原始来源哈希 |
| [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | ~154.0k★，MIT | 现代节点式 workflow UX | 只作信息架构与交互参考 |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | ~38.2k★，MIT | 可定制 React/Svelte DAG 画布 | Phase 5 控制台的候选直接依赖 |
| [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | ~55.4k★，已归档 | 视觉编排历史参考 | 不作为依赖；归档状态高于星标吸引力 |

### 1.4 由扫描新增的改进点

以下内容不只是此前“圆桌 + VPS”的延伸，而是本轮专项审计新增：

- **可复现 skill stack lockfile**：记录精确 skill ID、来源、版本、许可证、选择理由和覆盖缺口。
- **diff-based re-review**：只把变化和必要上下文交给复审者，同时由确定性门槛验证完整冻结包，节省 token 但不牺牲全包完整性。
- **研究 coverage map / question tree**：在开工前显示哪些视角、变量、数据源和反证尚未覆盖，借鉴 STORM 但落到结构化文件。
- **claim revision trajectory**：追踪一条主张从提出、证据增加、被削弱到修改/撤回的过程，而不只记录最终文本。
- **gold-set reviewer calibration**：用已裁决样例衡量假阳性、假阴性与遗漏类型，不以“模型说自己很好”作为质量证明。
- **无隐藏状态 notebook 入口**：允许 marimo/DVC/Quarto identity 进入 provenance，不强迫所有项目改变现有工具链。
- **技能供应链质量门槛**：外链失效、脚本语法、frontmatter、注册表一致性、许可证和供应商引导都进入 CI。
- **能力协商与 stack diff**：客户端、worker、模型和 skill 的实际可用能力先声明后分配任务，避免运行到一半才发现工具不存在。
- **隐私分级 trace**：默认只记录哈希、长度、耗时、状态与错误类别；原始 prompt/output 仅在项目明确 opt-in 后进入本地 trace。
- **灾难恢复演练**：不仅备份，还要定期从备份恢复到隔离目录并重新通过验证。

---

## 2. 五阶段总路线图

### 改进 1：近期“马上省时间”（P0，约 2–4 个专注开发日）

- 修正文档、稳定 tag 安装、coverage 与新任务发现测试。
- 增加 `doctor`，一次检查 Node、插件、MCP、项目 root、provider CLI、订阅路由和安全边界。
- 提供七个研究计划 preset 和交互式/非交互式 plan builder。
- 增加 dry-run：调用数、失败重试上界、最大等待时间、输入/输出预算与“包月 CLI / 单独计费 API”路由警示。
- 增加 acceptance preparation helper，只填充已验证的 ID/hash，保留 authority/status/note 给人决定。
- 对 `HUMAN_REVIEW_QUEUE.md` 做本地、去重的提醒；权威仍是文件，不依赖通知成功。

**退出门槛：** 新用户从固定 release 安装后，10 分钟内完成 doctor → 选 preset → dry-run → fake roundtable → verify → prepare acceptance；全程零付费调用，文档与实际输出一致。

### 改进 2：中近期“更便宜、更可靠、更可恢复”（P0/P1，约 1–2 周）

- 错误分类感知的 retry：quota/auth/model-not-found 不重试，timeout 默认不重试，格式修复最多一次且显式启用。
- 运行取消、进程组终止、不可变 cancellation 事件和重启后状态恢复。
- provider 调用幂等键和 `invocation_started/finished/unknown`，避免崩溃后重复扣额度。
- 跨进程 provider 并发/预算租约，不再只依赖单进程变量。
- 本地 trace、cost/time/queue 指标和 benchmark 基础设施。
- diff-based re-review、finding 生命周期和 remediation 证据链。
- 账本 checkpoint/index、离线 tombstone 清理计划、备份与恢复演练；禁止静默修复权威事件。

**退出门槛：** 强杀、超时、额度耗尽、两进程竞争和重复 resume 的故障注入均不产生重复权威结果或静默重复调用；旧 v0.1 项目仍可只读验证。

### 改进 3：中期“真正提高科研能力”（P0/P1，约 2–4 周）

- 建立 research question / estimand / population / comparator / outcome / time / unit 合同，标记探索性与验证性分析。
- 结构化证据定位器覆盖文件、行号、内容哈希、命令、退出码、输出哈希、URL、DOI 和检索时间。
- 增加偏倚、混杂、测量有效性、统计假设、缺失、多重比较、效应量/区间、功效与报告规范 profiles。
- 建立 claim–evidence matrix、主张类型、反证/负结果、source→analysis→figure→claim lineage。
- 增加 citation existence/support/retraction 检查与检索缓存边界。
- 增加显式 allowlist 的确定性命令执行器；AI 不能任意执行 `ACCEPTANCE.yaml` 中的文本命令。
- 建立 gold corpus、注入缺陷、FNR/FPR、独立评审者校准和 prompt/model/version lineage。
- 提供 DVC、marimo、Quarto、Great Expectations 的可选适配器，而非强制迁移。

**退出门槛：** 至少三个真实但脱敏的科研样例通过“方法、实现、数据来源、统计、图表、引用、结论”分门审核；系统能明确说“不足以判断”，而不是补造数据。

### 改进 4：中长期“无人盯守但仍可控”（P1，约 3–6 周）

- VPS coordinator 只维护任务、租约、不可变结果和通知；不保存模型账号凭证。
- Mac/Mac Mini worker 主动拉取任务，在本地调用 Qwen/GLM/Grok/Kimi 包月 CLI，并提交有签名/哈希的 attempt。
- worker 能力、资源、模型、skill 和保密等级协商；任务失败可恢复但不无限循环。
- HPC 仅执行确定性、大规模、可并行计算；遵守 Apocrita `computeshort` 约束。
- Tailscale 先行，Cloudflare domain/Access/Tunnel 作为独立授权的外部安全变更。
- 通知支持本地、Codex heartbeat 和可选任务管理/邮件/Slack 适配器；失败不改变项目状态。

**退出门槛：** coordinator 重启、worker 断线、租约过期、重复提交和网络分区测试全部通过；VPS 泄露不能直接得到本地模型凭证或未同步科研文件。

### 改进 5：长期“控制台、生态与规模化”（P1/P2，约 1–3 个月）

- 构建非聊天式 Research Control Plane：项目 rail、DAG、冻结包 identity、证据/发现矩阵、决定队列、成本/时间卡和人工审批面板。
- 加入跨项目 portfolio、搜索、键盘导航、深浅色、响应式与 WCAG 2.2 AA。
- 审批表导出自包含 `已填写版 HTML`；没有伴随 JSON/Markdown 才能返回。
- 完成 candidate → authorized upload → destination receipt → byte verification 的交付状态机。
- 引入 actor/worker 身份与可选 Ed25519 事件签名；Cloudflare 身份映射不等于自动科学权限。
- 建立科研 skill catalog、质量评分、composition recipes、兼容性/许可证锁定和社区贡献门槛。
- 拆分超大模块、增加 release automation、Dependabot、SBOM、provenance、beta/stable channel、备份恢复与 feature flags。

**退出门槛：** 用户不看终端也能在 3 分钟内回答“现在在哪一步、谁做了什么、证据在哪里、哪里不确定、下一次需要我决定什么”；UI 关闭后项目仍能完全由文件/CLI/MCP恢复。

---

## 3. Detailed Implementation Tasks

以下任务全部保持未勾选，直到用户授权对应阶段。

### Task 1.1: 修复 v0.1 文档、分发和 coverage 摩擦

**Files:**
- Modify: `README.md`
- Modify: `plugins/research-steward/package.json`
- Modify: `plugins/research-steward/package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Create: `plugins/research-steward/scripts/smoke-installed-plugin.mjs`
- Test: `plugins/research-steward/tests/distribution-contract.test.ts`

- [ ] 先写失败测试，断言稳定安装示例固定 `v0.1.0` 或最新 stable tag，状态文本不再称 release candidate。
- [ ] 加入与 Vitest 版本兼容的 coverage provider，并设置语句/分支/函数/行的初始基线；阈值只允许随版本上升。
- [ ] 写“独立临时 CODEX_HOME + tag marketplace + 全新 client session”分发 smoke，验证 8 个 skills、13 个 MCP tools 和 client roots 首调用。
- [ ] 在 CI 中把源码测试、bundle identity、安装缓存 smoke 分开呈现，避免把 dev dependency 缺失误报为发行失败。
- [ ] 运行 `npm ci && npm run check && npm run test:coverage`，随后从 tag 安装缓存运行独立 smoke。

### Task 1.2: 增加能力清单与 `research doctor`

**Files:**
- Create: `plugins/research-steward/src/doctor.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/cli.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/doctor.test.ts`
- Create: `plugins/research-steward/schemas/doctor-report.schema.json`

- [ ] 定义 `DoctorCheck`/`DoctorReport`，每项只返回 `pass | warn | fail | skipped`、证据摘要和修复建议，不输出 token 或秘密。
- [ ] 检查 Node、bundle、schema、plugin discovery、MCP tool inventory、root policy、项目可写性、provider executable 和路由边界。
- [ ] provider auth 只做无成本/最小安全 probe；无法保证零调用时标记 `skipped` 并给出人工命令，不伪造“已登录”。
- [ ] 添加 CLI `doctor` 与 MCP `research_doctor`；退出码区分 fatal 与 advisory。
- [ ] 测试缺 CLI、失效 root、占位 HTTP token、错误模型名、包月/API 冲突和秘密脱敏。

### Task 1.3: 提供 preset、plan builder 与可复现 workflow lock

**Files:**
- Create: `plugins/research-steward/src/presets.ts`
- Create: `plugins/research-steward/src/planner.ts`
- Create: `plugins/research-steward/presets/*.json`
- Create: `plugins/research-steward/schemas/workflow-lock.schema.json`
- Modify: `plugins/research-steward/src/cli.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/planner.test.ts`

- [ ] 固定七个 preset：`quick-review`、`blind-triad`、`full-panel`、`producer-reviewer-revision`、`manuscript-strict`、`figure-audit`、`code-science-audit`。
- [ ] plan builder 只询问会改变协议的字段：数据包、盲/开放、角色、模型路由、预算、deadline、科学 profiles。
- [ ] 输出不可变 `workflow.lock.json`，记录 preset 版本、skill IDs/versions、provider/model、能力缺口和生成器版本。
- [ ] MCP 提供纯预览 `research_build_plan`；只有显式 `--write`/工具参数才落盘，且不覆盖已有非空计划。
- [ ] 属性测试 DAG 无环、盲审 barrier 完整、adjudicator 依赖全体盲审报告、同一 actor 不自裁决。

### Task 1.4: 增加 dry-run 成本、时间和风险预览

**Files:**
- Create: `plugins/research-steward/src/forecast.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/cli.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/forecast.test.ts`

- [ ] 计算节点数、并行宽度、最坏重试数、输入字符/近似 token、输出上限、最长墙钟和每 provider 并发。
- [ ] route 必须显示 `subscription_cli | metered_api | fake | unknown`；任何 metered/unknown 路由默认给出阻止性警告。
- [ ] 不声称知道供应商真实剩余额度；只显示用户配置预算和理论上界。
- [ ] `dry-run` 绝不启动 provider，不创建 workflow events，只允许生成可审计 forecast 文件。
- [ ] 使用 fake 和故障计划验证估算守恒、重试上界和零付费调用。

### Task 1.5: 减少接受与注意力管理摩擦

**Files:**
- Create: `plugins/research-steward/src/acceptance-helper.ts`
- Create: `plugins/research-steward/src/attention.ts`
- Modify: `plugins/research-steward/src/store.ts`
- Modify: `plugins/research-steward/src/cli.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/acceptance-helper.test.ts`
- Test: `plugins/research-steward/tests/attention.test.ts`

- [ ] `prepare-acceptance` 只把最新 passing verification ID/hash 写入指定 approval 的 `accepts`；`status`、`authority`、`note` 保持人工填写。
- [ ] 如果 verification 已过期、存在后续协议事件或有未决 blocker，helper 必须拒绝。
- [ ] attention watcher 以队列内容哈希去重，本地通知失败只记录非权威诊断，不改变状态。
- [ ] 提供 `--no-notify`、安静时段和“醒来后第一项”摘要；默认不接第三方账户。
- [ ] 测试 helper 不会把 provisional review 提升成 acceptance，也不会替用户写具名权威。

### Task 2.1: 建立 typed provider failure 与保守 retry policy

**Files:**
- Create: `plugins/research-steward/src/provider-failure.ts`
- Create: `plugins/research-steward/src/retry-policy.ts`
- Modify: `plugins/research-steward/src/providers.ts`
- Modify: `plugins/research-steward/src/workflow.ts`
- Test: `plugins/research-steward/tests/retry-policy.test.ts`

- [ ] 分类 `quota | auth | model_not_found | timeout | transport | invalid_output | cancelled | unknown`，保留原始输出哈希而非秘密文本。
- [ ] 默认：quota/auth/model_not_found/cancelled/timeout 不重试；transport 可有限重试；invalid_output 仅在计划显式允许时做一次短格式修复。
- [ ] 每次 attempt 使用稳定 invocation ID，retry reason 与 backoff 成为事件证据。
- [ ] 用 provider fixtures 测试错误分类，不依赖供应商英语文案的单一字符串。
- [ ] 测试总调用次数永不超过 dry-run 预报上界。

### Task 2.2: 增加取消、幂等 invocation 和崩溃恢复

**Files:**
- Create: `plugins/research-steward/src/invocations.ts`
- Modify: `plugins/research-steward/src/providers.ts`
- Modify: `plugins/research-steward/src/workflow.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/cancellation.test.ts`
- Test: `plugins/research-steward/tests/invocation-recovery.test.ts`

- [ ] 协议新增 `invocation_started`、`invocation_finished`、`invocation_unknown`、`run_cancel_requested`、`run_cancelled`。
- [ ] `runProcess()` 接收 `AbortSignal`，在 macOS/Linux 终止进程组并等待退出；超时升级到 SIGKILL 的行为继续有界。
- [ ] 增加 MCP `research_cancel_run` 和 CLI `cancel`；取消请求不可删除已完成事件。
- [ ] 启动后崩溃但没有完成事件的调用标为 `unknown`，默认不自动重放付费调用，需要显式 resume policy。
- [ ] 故障注入覆盖断电窗口、HTTP client disconnect、重复 cancel、重复 resume 和迟到 provider 输出。

### Task 2.3: 跨进程 provider 并发、预算和公平性

**Files:**
- Create: `plugins/research-steward/src/provider-budget.ts`
- Create: `plugins/research-steward/src/runtime-paths.ts`
- Modify: `plugins/research-steward/src/providers.ts`
- Test: `plugins/research-steward/tests/provider-budget.test.ts`

- [ ] 使用 generation-fenced directory lease 扩展跨进程 permit，不复用项目事件锁。
- [ ] runtime 目录可配置并按用户隔离；不存凭证，只存 lease、provider、启动时间和匿名 invocation ID。
- [ ] 支持每 provider 并发、每 run 调用上限和用户定义时间窗预算；未知真实额度时不猜测。
- [ ] 公平队列避免一个大 run 饿死短任务，取消的 waiter 必须立即释放位置。
- [ ] 多进程测试验证 permit 上限、过期 lease 恢复、ABA 防护和无泄漏释放。

### Task 2.4: 账本索引、离线维护和恢复演练

**Files:**
- Create: `plugins/research-steward/src/ledger-index.ts`
- Create: `plugins/research-steward/src/maintenance.ts`
- Modify: `plugins/research-steward/src/store.ts`
- Modify: `plugins/research-steward/src/cli.ts`
- Test: `plugins/research-steward/tests/ledger-index.test.ts`
- Test: `plugins/research-steward/tests/maintenance.test.ts`

- [ ] 索引是可删可重建的缓存，包含 checkpoint sequence/head hash/offset；权威事件仍逐个验证到 checkpoint。
- [ ] `maintenance inspect` 只读报告 tombstone、断裂 head、陈旧索引和备份状态。
- [ ] `maintenance plan` 生成动作清单；`apply` 要求显式离线证明和精确目标，不静默重写事件。
- [ ] 增加隔离目录 restore rehearsal：从备份恢复后运行完整 verify 并对比 active packet identities。
- [ ] 用 10k/100k fake events 做性能回归，同时注入尾部删除、中间篡改和陈旧 checkpoint。

### Task 2.5: 本地可观测性与评估基础

**Files:**
- Create: `plugins/research-steward/src/telemetry.ts`
- Create: `plugins/research-steward/src/evaluation.ts`
- Create: `plugins/research-steward/evals/README.md`
- Create: `plugins/research-steward/evals/smoke/*.json`
- Test: `plugins/research-steward/tests/telemetry.test.ts`

- [ ] 定义 OpenTelemetry-compatible span 字段：run/node/actor/provider/model、queue/duration、attempt、status、hash和成本类别。
- [ ] 默认 trace 不含原始 prompt/output；项目 opt-in 后也只写本地、权限受限目录。
- [ ] 固定 benchmark case、预期 finding、可接受决定和已知不可判断项。
- [ ] 提供 JSON/OTLP file export；Langfuse/MLflow 导出必须单独启用并经过脱敏器。
- [ ] 测试 secrets、绝对私密路径和冻结正文不会进入默认 trace。

### Task 2.6: diff-based re-review 与 finding/remediation 生命周期

**Files:**
- Create: `plugins/research-steward/src/review-diff.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/workflow.ts`
- Modify: `plugins/research-steward/src/store.ts`
- Test: `plugins/research-steward/tests/review-diff.test.ts`
- Test: `plugins/research-steward/tests/finding-lifecycle.test.ts`

- [ ] diff packet 绑定 base/target packet hashes、变更文件、上下文窗口和完整 target identity。
- [ ] finding 状态区分 `open | fixed | accepted_risk | obsolete | deferred`；只有具名 adjudication 能改变 authoritative disposition。
- [ ] `fixed` 必须引用 remediation evidence 和新 packet；不能由作者一句“已修”关闭。
- [ ] 复审模型可以只看 diff，但 deterministic verify 始终检查完整 target packet。
- [ ] 测试重命名、二进制文件、行号漂移、旧 finding 重新出现和 accepted-risk 过期。

### Task 3.1: 冻结 Research Contract 与分析边界

**Files:**
- Create: `plugins/research-steward/src/research-contract.ts`
- Create: `plugins/research-steward/schemas/research-contract.schema.json`
- Create: `plugins/research-steward/skills/research-contract/SKILL.md`
- Modify: `plugins/research-steward/skills/research-steward/SKILL.md`
- Modify: `plugins/research-steward/src/store.ts`
- Test: `plugins/research-steward/tests/research-contract.test.ts`

- [ ] 合同字段包括 question、claim scope、estimand、population、intervention/exposure、comparator、outcome、time、unit、data cut、assumptions 和 exploratory/confirmatory。
- [ ] 合同版本作为 freeze/roundtable 依赖；合同变化要求新 packet，不改写旧结论上下文。
- [ ] 不适用字段必须显式 `not_applicable` + reason，不能靠空字符串混过去。
- [ ] 提供通用、实验、观察性、模型/仿真、文献综述 profile。
- [ ] 测试范围漂移、post-hoc confirmatory 伪装和不一致 outcome/unit。

### Task 3.2: 把证据定位器升级为结构化、可验证对象

**Files:**
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/generate-schemas.ts`
- Create: `plugins/research-steward/src/evidence.ts`
- Test: `plugins/research-steward/tests/evidence-locator.test.ts`

- [ ] 使用 discriminated union：`file_range`、`artifact`、`command_result`、`url`、`doi`、`dataset_record`。
- [ ] 文件证据记录相对路径、line/page/sheet/cell locator、内容或文件 hash；URL 记录 retrieval timestamp 和 content hash。
- [ ] 命令证据记录 argv 数组、cwd identity、exit code、stdout/stderr hash 和工具版本，永不保存 shell 插值字符串。
- [ ] 提供 protocol v1 free-text locator 的只读兼容和显式升级工具；不猜测无法解析的旧 locator。
- [ ] 属性测试 canonicalization、路径逃逸、URL fragment、表格单元格和 PDF 页码边界。

### Task 3.3: 建立 focused scientific audit skills

**Files:**
- Create: `plugins/research-steward/skills/research-question-audit/`
- Create: `plugins/research-steward/skills/data-provenance-audit/`
- Create: `plugins/research-steward/skills/statistics-audit/`
- Create: `plugins/research-steward/skills/bias-validity-audit/`
- Create: `plugins/research-steward/skills/citation-integrity/`
- Create: `plugins/research-steward/skills/reproducibility-audit/`
- Create: `plugins/research-steward/skills/claim-evidence-audit/`
- Create: `plugins/research-steward/skills/reporting-guidelines/`
- Test: `plugins/research-steward/tests/skill-catalog.test.ts`

- [ ] 每个 skill 保持短路由、明确触发范围、所需输入、禁止推断项、输出 schema、验证脚本和来源 references。
- [ ] statistics profile 覆盖效应量/CI、功效、假设、缺失、多重比较、数据泄漏和 sensitivity analysis。
- [ ] bias/validity profile 区分混杂、选择、测量、信息泄漏、外部效度和因果主张边界。
- [ ] reporting profile 以可选择清单接入 CONSORT/STROBE/PRISMA 等，不把清单通过等同于科学正确。
- [ ] 所有 skills 通过 frontmatter、链接、脚本、许可证、供应商引导和 fake fixture smoke。

### Task 3.4: 显式、受限的确定性命令执行器

**Files:**
- Create: `plugins/research-steward/src/check-runner.ts`
- Create: `plugins/research-steward/src/check-policy.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Test: `plugins/research-steward/tests/check-runner.test.ts`

- [ ] 新工具 `research_run_check` 只接收结构化 executable + argv，不接收 shell 字符串。
- [ ] 项目 policy 明确 executable allowlist、root、network、CPU/wall/output、环境变量和并发上限。
- [ ] 默认无网络、最小环境、项目根内 cwd；需要网络或外部路径时必须单独批准。
- [ ] 结果以 `command_result` evidence 提交；失败不被模型文本覆盖。
- [ ] 测试命令替换、路径逃逸、symlink、进程树、输出炸弹、超时和不允许的环境变量。

### Task 3.5: Claim–Evidence Matrix 与全链路 lineage

**Files:**
- Create: `plugins/research-steward/src/claims.ts`
- Create: `plugins/research-steward/src/lineage.ts`
- Modify: `plugins/research-steward/src/store.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Test: `plugins/research-steward/tests/claims.test.ts`
- Test: `plugins/research-steward/tests/lineage.test.ts`

- [ ] claim 类型区分 descriptive/associational/causal/predictive/mechanistic/methodological。
- [ ] 记录支持、削弱、矛盾和空证据；证据强度与不确定性不能被多数模型自动提升。
- [ ] lineage 节点覆盖 source→transform→analysis→table/figure→manuscript claim，并保存版本/hash。
- [ ] 生成 revision trajectory 和 coverage map，显示未覆盖的主张、变量、反证与视角。
- [ ] 测试一份来源被替换后下游 figure/claim 自动标为 stale，而不是自动判错。

### Task 3.6: 引用真实性、支持度和撤稿检查

**Files:**
- Create: `plugins/research-steward/src/citations.ts`
- Create: `plugins/research-steward/src/connectors/crossref.ts`
- Create: `plugins/research-steward/src/connectors/retraction.ts`
- Create: `plugins/research-steward/skills/citation-integrity/references/source-policy.md`
- Test: `plugins/research-steward/tests/citations.test.ts`

- [ ] 将存在性、元数据一致性、主张支持度和撤稿/更正状态分开，任何一项通过不替代其他项。
- [ ] 网络结果记录查询、时间、响应 hash 和来源；缓存过期策略写入证据。
- [ ] DOI/标题/作者模糊匹配只产生候选，不自动重写参考文献。
- [ ] PaperQA2 可作为可选本地 connector 候选；必须先用固定 corpus 验证 locator 和支持度误差。
- [ ] 离线时明确标记 `not_checked`，不把网络失败解释为“没有撤稿”。

### Task 3.7: 建立科研与评审校准 benchmark

**Files:**
- Create: `plugins/research-steward/evals/gold/`
- Create: `plugins/research-steward/evals/injected-faults/`
- Create: `plugins/research-steward/src/calibration.ts`
- Create: `plugins/research-steward/scripts/run-evals.mjs`
- Test: `plugins/research-steward/tests/calibration.test.ts`

- [ ] 至少覆盖引用错配、数值闭合、图表来源、统计假设、因果越界、代码/结果不一致和刻意不可判断。
- [ ] gold 标签由人或独立证据裁决产生，并记录 adjudicator 与依据；模型输出不能自封 gold。
- [ ] 报告 precision/recall/FNR/FPR、遗漏类型、成本、延迟和不稳定性；不只给总分。
- [ ] prompt、skill、model、provider、route、temperature/模式和 frozen corpus identity 全部版本化。
- [ ] CI 只跑零费用 deterministic/fake 子集；真实模型 eval 需要用户另行批准和预算。

### Task 3.8: 可选复现工具适配器

**Files:**
- Create: `plugins/research-steward/src/integrations/dvc.ts`
- Create: `plugins/research-steward/src/integrations/marimo.ts`
- Create: `plugins/research-steward/src/integrations/quarto.ts`
- Create: `plugins/research-steward/src/integrations/great-expectations.ts`
- Test: `plugins/research-steward/tests/integrations.test.ts`

- [ ] 每个适配器只探测版本与 artifact identity，除非通过 Task 3.4 policy 明确授权才执行命令。
- [ ] DVC 记录 stage/params/data hashes；marimo 记录纯 Python notebook identity；Quarto 记录 source/output；GE 记录 expectation suite/result。
- [ ] 项目不使用这些工具时完全零依赖、零警告噪音。
- [ ] 适配器失败只影响对应可选 gate，不改变核心协议可用性。
- [ ] 用最小 fixtures 验证来源改变会使输出 stale，且不会误把缺工具当科学失败。

### Task 4.1: 冻结 coordinator–worker 协议

**Files:**
- Create: `plugins/research-steward/src/worker-protocol.ts`
- Create: `plugins/research-steward/schemas/worker-job.schema.json`
- Create: `plugins/research-steward/schemas/worker-attempt.schema.json`
- Create: `docs/WORKER_PROTOCOL.md`
- Test: `plugins/research-steward/tests/worker-protocol.test.ts`

- [ ] 定义 worker capability、job lease、heartbeat、attempt、result receipt、cancel 和 stale-result 行为。
- [ ] job 使用 content-addressed input 与 idempotency key；worker 不获得任意服务器路径。
- [ ] confidentiality level 与 capability 匹配失败时拒绝分配，不做自动降级。
- [ ] 同一 job 的多个 attempt 可存在，但只有协议允许的一个结果进入下游；迟到结果保留为证据。
- [ ] 用模型检验/状态机测试覆盖重试、分区、重复 claim、lease steal 和 coordinator 重启。

### Task 4.2: VPS coordinator 与持久任务队列

**Files:**
- Create: `plugins/research-steward/src/coordinator/`
- Modify: `plugins/research-steward/src/server.ts`
- Create: `deploy/research-steward-coordinator.service`
- Create: `deploy/worker-token-policy.example.json`
- Test: `plugins/research-steward/tests/coordinator.test.ts`

- [ ] coordinator 只保存任务元数据、同步后的授权 packet、租约和结果；不保存 provider OAuth/API 凭证。
- [ ] worker 使用 scoped、可撤销、短期 token；每个 token 绑定项目/能力/操作。
- [ ] 队列采用 pull 模式，避免 VPS 主动进入本地设备；所有提交校验 input/output hash。
- [ ] systemd hardening、loopback/private bind、日志脱敏、备份和重启恢复作为发布门槛。
- [ ] 先在隔离 fake worker 上完成 soak test，用户另行批准后才触及真实 VPS。

### Task 4.3: Mac/Mac Mini 本地模型 worker

**Files:**
- Create: `plugins/research-steward/src/worker.ts`
- Create: `deploy/com.research-steward.worker.plist.example`
- Create: `docs/MAC_WORKER.md`
- Test: `plugins/research-steward/tests/worker.test.ts`

- [ ] worker 启动时声明 provider CLI/model/skill/CPU/RAM/保密能力，不上传本地账号资料。
- [ ] Qwen/GLM/Grok/Kimi 路由沿用 sealed cwd、无 shell、输出上限和不静默 API fallback。
- [ ] 支持 pause/drain/cancel、安静时段、资源上限和网络断开后的安全恢复。
- [ ] launchd 文件只引用外部 secret/env 位置，不包含真实 token。
- [ ] fake 与本地无成本 provider probe 通过后，真实模型测试仍需逐次预算授权。

### Task 4.4: HPC deterministic worker

**Files:**
- Create: `plugins/research-steward/src/hpc/slurm.ts`
- Create: `deploy/apocrita-computeshort.template.sh`
- Create: `docs/HPC_WORKER.md`
- Test: `plugins/research-steward/tests/slurm-policy.test.ts`

- [ ] 只接受 Task 3.4 已批准的确定性任务，不在 HPC 上运行持有个人订阅凭证的模型 CLI。
- [ ] 生成脚本固定 `computeshort`、≤1h、array 优先、≤480 cores、QoS normal/ood。
- [ ] 作业 ID、脚本 hash、input manifest、环境/module、exit 和 output hashes 写回 attempt。
- [ ] 提交、取消和结果拉取分开授权；密码或票据只用于当前会话，不落盘。
- [ ] 静态 policy 测试先于任何真实 `sbatch`；真实 HPC smoke 需用户单独批准。

### Task 4.5: 分层远程访问与通知

**Files:**
- Modify: `docs/CLOUDFLARE_PHASE2.md`
- Create: `plugins/research-steward/src/notifications/`
- Create: `plugins/research-steward/src/identity-map.ts`
- Test: `plugins/research-steward/tests/remote-boundary.test.ts`

- [ ] Tailscale 保持第一恢复路径；Cloudflare 文档站与写 MCP 使用不同 hostname/policy。
- [ ] Access JWT 必须在 origin 验证；Cloudflare identity 只映射操作身份，不自动授予 scientific acceptance。
- [ ] 通知 adapter 只消费 hash-deduplicated attention events，不读取完整冻结正文。
- [ ] 第三方 Todoist/邮件/Slack 连接均 opt-in、最小 scope、可禁用，失败不重试到骚扰用户。
- [ ] 外部 DNS/Tunnel/Access 变更仍需单独、即时授权和回滚快照。

### Task 5.1: 建立非聊天式 Research Control Plane 壳层

**Files:**
- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/src/`
- Create: `plugins/research-steward/src/read-model.ts`
- Create: `plugins/research-steward/src/read-api.ts`
- Test: `apps/control-plane/tests/app-shell.test.tsx`
- Test: `plugins/research-steward/tests/read-api.test.ts`

- [ ] 三栏信息架构：左侧项目/阶段 rail，中间 DAG/证据，右侧 attention/人工决定。
- [ ] UI 只通过 read model 读取物化视图；任何写动作调用现有治理 API，不直接编辑事件文件。
- [ ] 首屏在 3 秒内回答状态、阻塞、下一决定、最近验证 identity；长日志按需展开。
- [ ] 支持浅/深色、响应式、键盘导航、reduce motion、WCAG 2.2 AA 和统一状态色语义。
- [ ] 评估 `@xyflow/react` 后锁定版本和许可证；不依赖已归档 Flowise。

### Task 5.2: 科研 DAG、证据矩阵与 revision trajectory 视图

**Files:**
- Create: `apps/control-plane/src/features/dag/`
- Create: `apps/control-plane/src/features/evidence/`
- Create: `apps/control-plane/src/features/claims/`
- Create: `apps/control-plane/src/features/cost/`
- Test: `apps/control-plane/tests/science-views.test.tsx`

- [ ] DAG 节点显示 actor/model/route/status/uncertainty/dependencies，不显示隐藏 chain-of-thought。
- [ ] Evidence Matrix 可从 claim 跳到 locator、packet、finding、decision 和 remediation。
- [ ] coverage map 标出未覆盖视角、变量、反证、引用和 scientific profiles。
- [ ] cost/time 卡区分估算与实际、包月 route 与 metered route，未知值明确显示 unknown。
- [ ] 用大项目、长标题、中文/英文、色盲和窄屏视觉回归测试。

### Task 5.3: 人工审批与自包含已填写 HTML

**Files:**
- Create: `apps/control-plane/src/features/approval/`
- Create: `apps/control-plane/src/lib/filled-html-export.ts`
- Test: `apps/control-plane/e2e/filled-html-export.spec.ts`

- [ ] 主按钮中文为 `导出已填写版 HTML`，英文为 `Export filled HTML`。
- [ ] 导出文件内嵌当前选择、备注、verification identity 和 schema version，安全转义 `</script>`、HTML 和 Unicode 边界。
- [ ] 保留 blank/source HTML，导出新文件名包含 `已填写版`/`filled`；导出文件仍可编辑并再次导出。
- [ ] 全新浏览器、无 localStorage、离线环境打开后，所有输入可见且无重复 UI/运行时错误。
- [ ] 导出的表单是待签意见，不自动生成 acceptance event；回传后仍需具名权威提交。

### Task 5.4: 交付状态机与 byte receipt

**Files:**
- Create: `plugins/research-steward/src/delivery.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Modify: `plugins/research-steward/src/package.ts`
- Modify: `plugins/research-steward/src/server.ts`
- Test: `plugins/research-steward/tests/delivery.test.ts`

- [ ] 完整实现 `candidate_declared → delivery_authorized → delivery_recorded → delivery_verified`。
- [ ] 上传 connector 与本地 package 分离；任何外部写入需要精确 destination 和即时授权。
- [ ] receipt 记录远端 object/version/size/hash/time；无法验证 byte identity 时不得进入 verified。
- [ ] 重复上传用 idempotency key，destination mismatch/overwrite/version drift 均 fail closed。
- [ ] 提供 fake destination 和本地 filesystem fixture；真实云端 connector 逐个另行授权。

### Task 5.5: Actor/worker 身份与事件签名

**Files:**
- Create: `plugins/research-steward/src/signatures.ts`
- Create: `plugins/research-steward/src/key-policy.ts`
- Modify: `plugins/research-steward/src/protocol.ts`
- Test: `plugins/research-steward/tests/signatures.test.ts`

- [ ] 使用可选 Ed25519 detached signature 绑定 canonical event bytes、project ID、actor ID 和 key ID。
- [ ] 私钥只在本地 OS secret store/受限文件中；仓库与 VPS 只保存公钥和撤销状态。
- [ ] key rotation/revocation 不删除历史，旧事件按签署时有效性验证。
- [ ] 签名证明“谁的密钥提交了事件”，不证明事件科学正确，也不自动授予 acceptance 权限。
- [ ] 测试 replay、跨项目复制、key substitution、过期/撤销和 unsigned legacy events。

### Task 5.6: 科研 skill catalog、质量门槛和 composition recipes

**Files:**
- Create: `plugins/research-steward/skills/catalog.json`
- Create: `plugins/research-steward/skills/recipes/`
- Create: `plugins/research-steward/scripts/validate-skills.mjs`
- Create: `plugins/research-steward/src/skill-stack.ts`
- Test: `plugins/research-steward/tests/skill-stack.test.ts`

- [ ] catalog 记录 skill ID、版本、阶段、领域、输入/输出、风险、依赖、客户端兼容性、来源和许可证。
- [ ] validator 检查 frontmatter、目录/名称、registry/disk、相对链接、脚本语法、外链、许可证和 vendor steering。
- [ ] recipes 组合文献综述、实验、图表、论文、审稿回复、代码+科学审计等 focused skills，不加载一个巨型 prompt。
- [ ] skill selection 生成 `skill-stack.lock.json` 与选择证据，支持 diff 和缺口报告。
- [ ] 社区贡献必须附 fixture、失败边界、来源和许可证；星标不是准入条件。

### Task 5.7: 可维护性、供应链和发布治理

**Files:**
- Refactor: `plugins/research-steward/src/store.ts`
- Refactor: `plugins/research-steward/src/workflow.ts`
- Refactor: `plugins/research-steward/src/server.ts`
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/scorecard.yml`
- Create: `docs/RELEASE_CHANNELS.md`
- Test: existing full test suite plus clean-room release smoke

- [ ] 用 characterization tests 先冻结行为，再把 store 拆成 ledger/views/packets/verification/acceptance，workflow 拆成 graph/execution/barrier/adjudication。
- [ ] server 工具注册改为小模块，保持 tool names/schema backward compatibility。
- [ ] release 生成 SBOM、依赖审计、bundle/source identity、provenance、changelog 和 stable/beta channel。
- [ ] Dependabot/安全告警不自动合并；每次升级跑 clean-room install、三 transport smoke、schema diff 和 secret scan。
- [ ] 每季执行备份恢复、key rotation、worker revoke、VPS rollback 和 Cloudflare/Tailscale recovery 演练。

---

## 4. 并行关系与禁止越过的门槛

可并行：

- Task 1.2–1.4 可在独立模块并行，但 1.1 的分发基线必须先冻结。
- Phase 3 的科学 schema/skills 可以与 Phase 2 的可靠性模块并行设计，但 protocol version 合并必须串行裁决。
- 控制台视觉原型可在 Phase 3 后半并行进行，正式写 API 必须等待 read model 和协议稳定。
- HPC adapter 可在 worker protocol 冻结后独立开发，不必等待 Mac Mini 采购。

不可越过：

- 没有 Task 2.1–2.3 的幂等、取消、预算与跨进程租约，不启动无人盯守真实模型 worker。
- 没有 Task 3.1–3.7 的科学合同和校准，不把“圆桌输出”宣传为科研质量保证。
- 没有 coordinator 断线/重放测试，不把写端点暴露到 Cloudflare。
- 没有自包含 HTML fresh-browser 测试，不交付任何需要他人填写并返回的网页。
- 没有 destination receipt 和 byte verification，不宣称外部交付完成。

---

## 5. 建议的授权切片

未来用户可以只授权一个小切片，不必一次批准整阶段。建议最小安全切片为：

1. **Slice A：** Task 1.1–1.4，纯本地、fake-only、无外部系统写入。
2. **Slice B：** Task 1.5 + 2.1–2.3，仍本地，加入提醒/取消/预算但不调用真实模型。
3. **Slice C：** Task 3.1–3.7，先用脱敏/合成科研样例建立科学门槛。
4. **Slice D：** Task 4.1–4.3，先 fake coordinator/worker，再单独授权 VPS 与真实 CLI。
5. **Slice E：** Task 5.1–5.3，只读控制台和自包含审批出口。

每次授权后都应把当次允许的文件、外部系统、模型路线、预算和停止条件写成一个短 execution packet；未写入 packet 的能力保持冻结。

---

## 6. 最终成功指标

- **效率：** 常见项目从“手写配置”降到 preset + 5 个以内关键选择；人工只在真正需要判断的队列项出现时介入。
- **成本：** 每次真实调用前能看见路由、上界和重试政策；崩溃/resume 不产生未知的重复付费调用。
- **科研：** 每个关键 claim 能回到来源、分析、图表和定位器；系统能区分证据不足、证据矛盾和真正失败。
- **可靠性：** 任意单一 client、worker、coordinator 或 UI 关闭后，项目都能由冻结文件和事件账本恢复。
- **扩展性：** 新 skill/worker/provider 通过能力清单、schema、fixture 和许可证门槛接入，不修改核心科学接受规则。
- **美观性：** 控制台优先展示状态、证据、风险与下一决定，避免聊天墙；中英文、窄屏、深浅色与键盘操作均可用。
- **时间回收：** 用户醒来时获得一页可执行摘要，而不是重新阅读整夜日志；无需持续盯守模型，但仍保有最终科学决定权。

## Plan Freeze Record

- Created: 2026-08-31
- Status: `AUTHORIZED_FOR_CLAUDE_EXECUTION`
- Execution authorization: `ALL_LOCAL_IMPLEMENTATION_TASKS`
- External mutations authorized: `READ_ONLY_AND_REVERSIBLE_PREPARATION_ONLY`; destructive/security-sensitive/public mutations require a separate user-confirmed execution packet.
- Model calls: existing subscription/Coding Plan routes may be used with explicit budgets and provenance; separately metered APIs, including DeepSeek API, require separate user approval.
- First permissible next action: Claude Code reads the handoff prompt, creates an isolated worktree, verifies the plan hash, performs the cross-task conflict scan, creates the durable progress ledger, and begins Task 1.1.
