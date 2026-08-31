# Architecture and frozen protocol

## Why this is a plugin, not one giant skill

Codex discovers sibling `skills/<name>/SKILL.md` directories independently. Research Steward therefore uses a short router plus focused skills. Shared schemas and policies are explicit support material, not an implicitly invoked mega-prompt.

## Project state machine

```text
draft -> frozen -> reviewing -> adjudicated -> verified -> accepted -> packaged
   \         \            \          \           \
    +---------+------------+----------+-------------> blocked
                                                     |
                                     block_resolved -+-> previous stable state
```

State changes are events. A generated status view may summarize them, but editing that view cannot silently advance the state machine.

`candidate_declared`, `delivery_recorded`, and `delivery_verified` remain reserved event names in v0.1. They do not yet have complete first-class CLI/MCP gates and must not be presented as implemented end-to-end workflows. Any blocking event remains active until a `block_resolved` event explicitly depends on it; unrelated later work cannot clear the state.

Freezing a replacement is explicit: `research_freeze_packet` accepts a `supersedes` list containing existing, still-active packet IDs. Supersession never rewrites or deletes prior packets. Verification continues to check their frozen-byte integrity, while source-freshness checks apply only to active packet generations. A packet may be superseded at most once.

## Authoritative project files

Initialization creates, without overwriting non-empty user files:

- `STATUS.md`: human-readable materialized state.
- `TASK.md`: objective, scope, inputs, constraints, and open questions.
- `DECISIONS.md`: human-readable decision ledger.
- `ACCEPTANCE.yaml`: deterministic and human acceptance gates.
- `HANDOFF_MANIFEST.yaml`: local package identity, contents, and provenance.
- `.research/manifest.json`: machine-readable project identity and protocol version.
- `.research/events/`: immutable, one-event-per-file authority.
- `.research/frozen/`: content-addressed review packets.
- `.research/rendered/ROUND_TABLE.md`: generated shared conversation view.

`HUMAN_REVIEW_QUEUE.md` is a generated attention surface, not an authority file. A `provisional_review` can place a passing verification there with a requested review time, but it cannot create acceptance or authorize packaging.

## Center-spoke workflow as a durable DAG

A roundtable plan is a directed acyclic graph. Each node names an actor, model adapter, role, brief, dependencies, visibility, and timeout. A node becomes runnable only when every dependency has committed a valid immutable event.

```text
frozen packet
     |
 producer_draft
   /       \
methods   evidence       blind peers can instead branch directly from packet
   \       /
 adjudicator
     |
 deterministic verifier
```

Open collaboration may include selected prior events in downstream prompts. Blind review gives peer nodes the same frozen packet but hides peer output until all required reports are committed. The adjudicator reads frozen reports and records `accept`, `partial`, `reject`, or `defer` with evidence and rationale.

Blind turns and their disclosure barrier are created only by the governed roundtable workflow. The manual MCP append tool accepts `shared` or `private` visibility, not `blind`; there is no manual barrier-close API. A downstream adjudicator of blind output must depend on every report named by the completed barrier.

Finding IDs are unique across the entire project ledger. Roundtable-generated findings are namespaced with their workflow node ID; manually appended findings must already use a project-unique ID. An actor cannot author a finding and commit its authoritative disposition. Deterministic verification fails until every disclosed, completed reviewer finding has an adjudication disposition.

## Storage and concurrency

Multiple processes never own the same Markdown write. Every contribution is validated, written to a temporary file in the target directory, flushed, and atomically renamed to a unique immutable event file. Sequence allocation is protected by a generation-fenced directory lease: a candidate directory already containing its random owner token is atomically renamed into place, and a writer rechecks ownership immediately before each authoritative commit. Run coordinators use the same lease primitive and refuse later commits with `LOCK_LOST` if their generation is replaced. A durable ledger head anchors the event count and final hash so deleting a contiguous tail is detected. Parent directories are synchronized where supported. `events.jsonl`, `ROUND_TABLE.md`, `STATUS.md`, and `DECISIONS.md` are regenerated views outside the event lock.

Expired and released lease generations are atomically renamed to deterministic `.retired-<generation>` directories and deliberately retained as non-overwritable tombstones. They close the delayed-release ABA window in which an old owner could otherwise remove or rename a successor's live lease. Their count follows lease release/recovery history rather than research-event volume; project verification ignores them. They may be removed only during explicit offline maintenance after every writer and coordinator for that project has stopped. v0.1 does not perform online tombstone cleanup.

The event directory is the durable workflow history. Resuming the same roundtable run reconstructs completed dependencies from valid events and runs only remaining nodes. A hard crash between committing an event file and updating the separate ledger head fails loudly; v0.1 has no general repair or recovery API.

Ledger reads validate the complete event sequence and hash chain, and project verification scans the complete frozen-packet set. This fail-closed design favors auditability over constant-time access; very large long-lived projects will eventually need checkpointing or indexing that v0.1 does not provide.

## Provider boundary

Adapters call existing CLIs without a shell and never receive stored credentials from Research Steward. Real providers run in a sealed temporary cwd with bounded output and a process-level concurrency permit. This is context reduction, not an operating-system sandbox: the provider still runs as the same OS account. The initial adapters target Kimi Code, Qoder CN, and Grok; a deterministic fake adapter exists only for explicitly opted-in tests. Qoder disables tools, MCP, plugin discovery, and session persistence. Kimi is rejected from blind lanes because its current CLI cannot prove the same boundary. Grok explicitly removes `XAI_API_KEY` and uses its subscription/OAuth session plus a mode-0600 prompt file. Each result records the adapter, requested model, exit status, duration, output hash, frozen input hash, and hashes plus lengths for failure diagnostics. Hidden chain-of-thought is neither requested nor stored.

Kimi currently places prompts in argv, which is a same-host confidentiality limitation. Qoder receives prompts over stdin, while Grok uses a mode-0600 prompt file. The sealed cwd prevents accidental project traversal but does not defend against a privileged local process observer. Closing an HTTP request also does not currently cancel an already-started provider process.

## Verification boundary

The deterministic verifier checks schemas, hashes, required files, packet/source freshness, finding coverage, and acceptance-document syntax. It explicitly depends on every packet and finding/adjudication event it verified. It parses the `commands` field but never executes those commands. It cannot decide whether a scientific interpretation is true.

Scientific acceptance is a named human act after verification. Every required approval in `ACCEPTANCE.yaml` must name the same passing verification event ID and event hash, and the recording actor must be one of those named authorities. The acceptance event binds the exact `ACCEPTANCE.yaml` bytes and a normalized required-approval snapshot. A provisional review and `HUMAN_REVIEW_QUEUE.md` do not satisfy this gate. Packaging then copies only the accepted frozen bytes and records packet, verification, and acceptance provenance; v0.1 does not implement delivery.
