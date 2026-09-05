# Research Steward evals

这个目录存放离线评测用的固定 case。评测代码在 `src/evaluation.ts`：
`loadEvalCases()` 负责读取并校验 case，`scoreEvalRun()` 对一次已经跑完的
roundtable 结果做纯计算打分（precision / recall / FNR / FPR），本身绝不调用
任何模型。

## Gold 标签的来源要求

case 里的 `expected` 是 gold 标签，只能来自人工裁决，或者能独立复核的证据
（比如指向冻结 packet 里具体行的对照），二者都要写进 `provenance.adjudication_basis`。
禁止用被评测的模型（或同类模型）的输出反过来充当 gold 标签。人工裁决不了的
finding 不要硬贴标签，放进 `expected.undecidable`，打分时会整体排除。

## CI 只跑零费用子集

`evals/smoke/` 下的 case 全部使用确定性的 `fake` adapter（`input.kind` 固定为
`"fake_roundtable"`），不需要凭据、不产生任何费用，CI 里只允许跑这一类。
当前的 smoke 集合：

> **当前三个 smoke case 的 gold 标签是 `synthetic_expected_behavior`：由测试设计直接构造，尚未经过任何独立真人裁决。**在补齐真实冻结 fixture、逐 finding 定位、独立标注记录之前，不得把它们称为 human-adjudicated benchmark；`tests/eval-provenance.test.ts` 会机器强制这一点，同时拒绝任何个人邮箱进入公开 eval fixture。

- `smoke-001-clean-panel.json`：两个必须命中的缺陷加一个诱饵负例。
- `smoke-002-missed-critical.json`：盲审对照，含关键证据缺口和两个负例。
- `smoke-003-undecidable.json`：刻意保留一个人工无法裁决的 finding，用来验证
  undecidable 排除逻辑。

## 真实模型 eval 需要用户批准

任何调用真实 provider 的 eval（哪怕走订阅制 CLI、名义上"免费"）都必须先获得
用户明确批准后才能执行，且不属于 CI 的默认流程。批准后跑出的结果也只用
`scoreEvalRun()` 离线打分，不回写 gold 标签。
