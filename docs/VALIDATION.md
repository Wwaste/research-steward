# Validation record

Validation is layered because a successful model response is not evidence that filesystem, concurrency, security, or scientific contracts hold.

## Deterministic suite

The release-candidate suite currently covers:

- idempotent initialization and preservation of researcher-owned files;
- project-root and symlink containment;
- credential-like filename rejection;
- frozen-byte hashes and tamper detection;
- immutable event hashes, sequence gaps, filename mismatches, and duplicate detection;
- generation-fenced event/run leases, delayed-owner release, stale recovery, and commit refusal after ownership loss;
- concurrent event writers without lost or reused sequences, including 16-way stale-lock recovery;
- DAG ordering and explicit dependency event IDs;
- blind-peer dependency rejection and barrier closure;
- reviewer/adjudicator authority separation;
- one disposition per upstream finding and complete blind-group dependencies for manual adjudication;
- inclusion of structured upstream findings in adjudicator prompts;
- fail-closed zero-finding adjudication and rejection of invented finding IDs without a paid-model retry;
- fail-loud provider diagnostics using hashes and lengths rather than raw output;
- durable failure-budget termination with blocked downstream nodes and `result.json`;
- deterministic verification versus scientific acceptance;
- acceptance-file symlink containment without reading or echoing root-external contents;
- private/blind-event filtering in shared materialized views;
- handoff archive path traversal, identity, hash, copied-byte, and concurrent no-clobber checks.

Run all checks with:

```bash
cd plugins/research-steward
npm ci
npm run check
npm audit --audit-level=moderate
node scripts/smoke-mcp.mjs
node scripts/smoke-client-roots.mjs
node scripts/smoke-http.mjs
```

The 2026-08-31 v0.1.0 release-candidate run passed 81 tests across 12 test files, TypeScript typechecking, and both standalone builds. Four focused concurrency attacks were each repeated for 20 rounds: delayed predecessor release, 16-way run-lease recovery, 16-way event-lock recovery, and concurrent revision supersession. In the supersession attack exactly one revision won, the loser failed with `PACKET_ALREADY_SUPERSEDED`, one successor event was committed, and the losing frozen directory was rolled back in all 20 rounds. This regression was added after a GLM review correctly identified a protocol-coverage gap; inspection showed that the event lease and rollback path already enforced the invariant, so the finding changed the specification and test coverage rather than the locking algorithm.

At the earlier 80-test checkpoint, an independent Claude Code run repeated the three lease-concurrency files five times, passed the then-current full suite, and completed its own CLI walkthrough. It also launched 16 independent CLI processes in each of 20 stale-lock rounds: all 320 appends succeeded, the 321-event ledger was continuous and unique, no live lock remained, and all 341 retired generations contained an owner token whose hash matched the directory generation. Its proposed age-based online tombstone cleanup was withdrawn after the arbitrarily delayed-predecessor counterexample; cleanup remains offline-only.

The checked-in fake adapter produces test-only `info` findings and the adjudicator records evidence-linked `defer` dispositions. A clean temporary-project walkthrough using the committed `dist/cli.mjs` confirmed that a provisional review does not authorize packaging, named acceptance does, and a `candidate-v2 --supersedes candidate-v1` revision invalidates the old acceptance until a new verification and acceptance are recorded. Explicit-root stdio, client-granted-root stdio, and HTTP smoke checks each discovered 13 MCP tools. The client-roots check removes `RESEARCH_STEWARD_ROOTS`, makes its first tool call without a sleep, and passed 20/20 repetitions after fixing the initialization race. Plugin validation and all eight skill validators passed. `npm audit --audit-level=moderate` reported zero vulnerabilities.

Clean-room `npm ci` reconstruction and two in-place rebuilds produced identical release bundles:

| Artifact | SHA-256 |
|---|---|
| `dist/cli.mjs` | `9070e416b0ed116eb579036d38f70dea0562d5703ac05a55e434cba7f0cc684f` |
| `dist/server.mjs` | `ab374ea063de9d498d1e32ade4f6a9b630bb55ef79a3523754f03c00b85eb7f8` |
| `schemas/project-manifest.schema.json` | `1634d540fc9a1ebc2b93e5d4ac5a9f99069f5d88a7440a15ba7825a514ddec34` |
| `schemas/research-event.schema.json` | `091f902d50bdb4cb2e7159e37453ccf6f7a49d31d58f571afafb51dc70ddb90f` |
| `schemas/roundtable-plan.schema.json` | `10c852cce08a1788f7b2e863e927414235760d560da07ddedee70e5b853c25f9` |

CI rebuilds the committed standalone bundles and public JSON schemas, and fails if either differs from source. Build probes must install dependencies inside the clean room: an absolute symlink to another checkout's `node_modules` changes esbuild's internal module labels and therefore its bytes even when source and dependency versions are identical.

To probe an already deployed HTTP endpoint through its real reverse-proxy path:

```bash
RESEARCH_STEWARD_ENDPOINT=https://<private-host>/research-steward/mcp \
RESEARCH_STEWARD_HTTP_TOKEN=<injected-secret> npm run probe:http
```

The probe checks service identity, an unauthenticated `401`, an authenticated MCP initialization, and the required tool inventory without printing the token.

## Live provider exercises

Live exercises are evidence about adapter behavior, not scientific correctness:

- On the final bundle above, Qoder CN ran `GLM-5.3-Flash` from stdin and then a deterministic fake adjudicator in run `glm-final-client-roots`; both nodes completed, with no failed/blocked node and no model substitution.
- `Qwen3.8-Max` completed a separate one-node structured-output run through the same Qoder stdin/empty-MCP route.
- Grok 4.6 completed a subscription/OAuth structured-output run with `XAI_API_KEY` explicitly absent.
- Kimi K3 completed a shared/open structured-output run after its subscription quota recovered. It remains prohibited from blind lanes because the current CLI cannot prove a deny-tools boundary.
- A three-Qoder panel failed closed: GLM completed, `Qwen3.8-Flash` reached its 300-second timeout, and the dependent Qwen Max adjudicator was blocked rather than called or silently replaced.
- Larger prompt-only source reviews also exposed timeout and invalid-output paths. Those failures led to bounded prompt allocation, upstream finding preservation, hashed diagnostics, and durable failure-budget termination.

Provider availability and subscription quotas are external state. Re-run the live examples before relying on a specific model route.

## What these checks do not prove

- That a scientific interpretation is true.
- That a cited external source supports a claim unless the source itself is frozen and reviewed.
- That a package was uploaded or received; packaging and delivery verification are separate events.
- That a remote client is authorized merely because `/healthz` responds.
- That `.retired-*` lease tombstones can be deleted while writers may still be alive. v0.1 retains them to fence arbitrarily delayed predecessors; cleanup is offline-only after all writers and coordinators stop.
