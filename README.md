# Research Steward

Research Steward is a local-first, auditable research-operations plugin for Codex and other MCP clients. It turns multi-model collaboration into a durable workflow: initialize a research workspace, freeze an evidence packet, collect attributable contributions, run blind or open review, adjudicate findings, verify deterministic acceptance checks, and package a handoff.

It is deliberately a protocol and integration layer, not another general-purpose agent framework. Existing model CLIs remain responsible for model access; Research Steward supplies the missing research state machine, provenance, immutable artifacts, stopping rules, and verification gates.

## What it solves

- Agent A can commit a result and Agent B is triggered only after that immutable event exists.
- Blind peers see the same frozen bytes without seeing one another's reports.
- Every contribution records actor, role, requested model, dependencies, hashes, uncertainty, and evidence locators.
- Ordinary reviewers can report findings but cannot write authoritative decisions.
- A named adjudicator accepts, partially accepts, rejects, or defers findings using evidence rather than a model vote.
- Deterministic checks, exact-byte scientific acceptance, and packaging remain separate enforced gates. Candidate and delivery event names are reserved for a later API and are not claimed as complete v0.1 workflows.
- A blocked project remains blocked until an explicit resolution event names the blocking event IDs.
- A low-authority provisional review can keep asynchronous work organized, but it never authorizes acceptance or packaging; pending human work is rendered in `HUMAN_REVIEW_QUEUE.md`.
- Generated Markdown is a readable view; immutable event files are the authority.
- Event writers and run coordinators use generation-fenced directory leases; internal `.retired-*` tombstones are expected safety markers, not research artifacts.

## Repository layout

```text
.agents/plugins/marketplace.json       repo-local Codex marketplace
plugins/research-steward/
  .codex-plugin/plugin.json            plugin manifest
  .mcp.json                            local MCP launcher
  skills/                              umbrella router plus focused sibling skills
  schemas/                             public protocol schemas
  src/                                 orchestration, CLI, and MCP source
  tests/                               contract, integration, and security tests
  examples/                            fake and live provider plans
deploy/                                hardened remote-service templates
docs/                                  prior-art and validation notes
```

The sibling-skill structure follows Agent Skills discovery semantics: the umbrella `research-steward` skill routes work, while project setup, roundtables, blind review, adjudication, verification, and packaging remain independently invocable.

## Install in Codex

Node.js 20 or newer is required. The repository commits standalone bundles, so normal plugin use does not require a global TypeScript toolchain.

```bash
codex plugin marketplace add Wwaste/research-steward --ref v0.1.0
codex plugin add research-steward@research-steward
```

For development from a local checkout:

```bash
git clone https://github.com/Wwaste/research-steward.git
cd research-steward/plugins/research-steward
npm ci
npm run check
codex plugin marketplace add ../..
codex plugin add research-steward@research-steward
```

Start a new Codex task after installation so skill and MCP discovery starts from a clean context.

## Five-minute CLI walkthrough

```bash
cd research-steward/plugins/research-steward
node dist/cli.mjs init --project /path/to/project --title "My research project"
node dist/cli.mjs freeze --project /path/to/project --packet protocol-v1 \
  --file manuscript.tex --file results/table.csv
RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER=1 node dist/cli.mjs roundtable \
  --project /path/to/project --plan examples/fake-roundtable.plan.json
node dist/cli.mjs verify --project /path/to/project
# If the named human is offline, an agent may record a provisional review of
# the printed verification ID. This adds a persistent human-review reminder;
# it does not unlock acceptance or packaging.
# Edit ACCEPTANCE.yaml: name the accepting authority and change each required
# approval from pending to approved/accepted, then copy the latest verification
# event ID and hash into its accepts block:
node dist/cli.mjs accept --project /path/to/project \
  --actor researcher-id --note "Accepted the verified frozen candidate."
node dist/cli.mjs package --project /path/to/project --package handoff-v1 \
  --file manuscript.tex --file results/table.csv
```

The walkthrough uses the deterministic fake adapter so it is reproducible and never consumes a model subscription. Reviewer lanes emit test-only `info` findings and the fake adjudicator records `defer`, making the decision chain visible without pretending to make a scientific judgment. Copy `examples/real-review.template.json`, set its `packet_id`, and review its model/cost limits before a live round table.

For an overnight or otherwise asynchronous handoff, record a low-authority review after `verify`:

```bash
node dist/cli.mjs provisional-review --project /path/to/project \
  --actor overnight-agent --verification <verification-event-id> \
  --review-by "next wake-up" \
  --note "Automated checks passed; named human confirmation remains required."
```

The project remains usable for further agent work. If any later research event is committed, the queue changes to `reverification_required`; finish the work and run `verify` again before asking for human acceptance.

Initialization is idempotent and will not overwrite non-empty researcher files. It creates:

- `TASK.md` for objective, scope, inputs, constraints, and open questions.
- `STATUS.md` as a materialized project-state view.
- `DECISIONS.md` as a materialized adjudication view.
- `ACCEPTANCE.yaml` for deterministic and human gates.
- `HANDOFF_MANIFEST.yaml` for package and delivery identity.
- `.research/events/` as the immutable event authority.
- `.research/frozen/` as content-addressed review packets.
- `.research/rendered/ROUND_TABLE.md` as the shared human-readable conversation.
- `HUMAN_REVIEW_QUEUE.md` as a generated, persistent list of pending human confirmation and blocker IDs.

The meaningful human step is deliberately small but cannot be delegated away. Before `accept`, edit the generated approval block in `ACCEPTANCE.yaml`:

```yaml
human_approvals:
  - id: scientific-acceptance
    required: true
    status: approved
    authority: researcher-id
    accepts:
      verification_event_id: "copy-from-the-latest-verify-output"
      verification_event_hash: "copy-from-the-latest-verify-output"
    note: "I accept the exact frozen and verified candidate."
```

The acceptance event binds the approval to the exact ID and hash printed by the latest passing `verify` command, as well as the exact YAML bytes and a normalized required-approval snapshot. Provisional-review events targeting that verification may appear in between; any other later protocol event requires a new verification and a deliberate update of those two target fields. Any research or governance event committed after acceptance likewise requires re-verification and a new acceptance before packaging.

When revising an already frozen candidate, preserve its history and explicitly supersede it:

```bash
node dist/cli.mjs freeze --project /path/to/project --packet candidate-v2 \
  --supersedes candidate-v1 --file manuscript.tex --file results/table.csv
```

Superseded packets still undergo frozen-byte integrity checks. Only active packets undergo current-source freshness checks and become dependencies of the next verification.

## Model adapters and cost boundary

| Adapter | Intended route | Safety behavior |
|---|---|---|
| `qoder` | Qoder CN Coding Plan, including Qwen and GLM model names | Prompt over stdin, sealed cwd, no tools/MCP/persisted session, empty plugin directory, bounded output, no shell interpolation |
| `grok` | Existing grok.com/OAuth Coding Plan | Explicitly removes `XAI_API_KEY`, disables web/tools for frozen review, and uses native JSON Schema output |
| `kimi` | Existing Kimi Code subscription | Shared/open lanes only; the current CLI cannot prove a deny-tools blind boundary, and quota exhaustion becomes a failed event |
| `fake` | Tests only | Disabled unless `RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER=1` |

Research Steward never substitutes an uncalled model, silently changes a blind run into an open run, or falls back from a subscription CLI to a separately metered API. DeepSeek API routing is intentionally not included in v0.1.0.

Kimi currently receives the prompt through a command argument. This is acceptable only on a trusted single-user host because sufficiently privileged same-host observers may inspect process arguments. Qoder uses stdin, and Grok uses a mode-0600 prompt file.

## MCP: local first, remote when shared state is real

The plugin's default MCP transport is stdio. This is the lowest-friction and safest option because the client grants explicit filesystem roots and no network credential is needed.

Remote HTTP mode is available for a genuinely shared server-side project root. It requires all of:

- an explicit `RESEARCH_STEWARD_ROOTS` allowlist;
- a non-placeholder 256-bit bearer token (for example, `openssl rand -hex 32`);
- explicit Host and Origin allowlists;
- a private interface or authenticated reverse proxy.

The shared bearer authenticates the coordinator endpoint, not each named AI participant. Actor IDs are protocol assertions, and `blind`/`private` control prompt routing and shared output; they are not a multi-tenant confidentiality boundary. Do not give the same remote endpoint to mutually untrusted participants.

The manual `research_append_turn` tool accepts only `shared` and `private`. Blind review must use `research_run_roundtable`, which has a frozen participant plan and closable barrier. Finding IDs are project-wide identifiers; manual callers should use an actor-qualified form such as `reviewer-a.method-1`.

Do not deploy remote MCP merely to reach files that still exist only on one laptop. Remote orchestration becomes useful after the authoritative project data is actually synchronized to the server. See [deploy/README.md](deploy/README.md).

## Design principles

- Files before chat: authoritative events and frozen packets survive client restarts.
- One logical writer: agents submit immutable events; generated Markdown is never concurrently appended.
- Independent evidence lanes: agreement is not validation, and adjudication is not voting.
- Blindness is explicit and enforced before provider invocation.
- Model claims do not satisfy deterministic acceptance checks.
- Failures are terminal evidence: timeout, quota, invalid schema, and dependency failure become attributable events and a durable run result.
- Blocks are cleared only by an immutable `block_resolved` event naming the unresolved blocking events.
- Credentials remain with existing CLIs or protected service configuration; they are never put in plans or event logs.

## Documentation

- [Architecture and protocol](ARCHITECTURE.md)
- [Security model](SECURITY.md)
- [Validation record](docs/VALIDATION.md)
- [Prior-art review](docs/PRIOR_ART.md)
- [VPS and Tailscale deployment](deploy/README.md)
- [Cloudflare phase 2 plan](docs/CLOUDFLARE_PHASE2.md)
- [Contributing](CONTRIBUTING.md)

## Status

v0.1.0 released. Protocol schemas are versioned, but the public API may still change before v1.0. Large prompt-only code reviews are a known weak fit for heavyweight terminal-agent CLIs; use focused frozen packets and deterministic tests instead of treating a model review as a release gate.

Cloudflare domain, Access, and Tunnel integration are a planned second phase after private Tailscale deployment is stable. No DNS or Cloudflare account changes are required for the first release.

## License

Apache-2.0. No code is copied from the license-conflicted `yylo-dev/roundtable` project.
