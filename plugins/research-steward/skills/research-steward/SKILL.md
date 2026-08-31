---
name: research-steward
description: Route multi-stage research operations that need durable project state, frozen evidence, multi-model collaboration, independent review, adjudication, deterministic verification, or handoff packaging. Use this as the umbrella entrypoint; use a focused sibling skill directly for narrow requests.
---

# Research Steward

Treat this skill as a short control-plane router. Do not preload every sibling skill.

## Route the request

| User need | Focused skill |
|---|---|
| Initialize or inspect the five canonical project files and ledger | `project-workspace` |
| Let A produce, B automatically read, and C respond | `roundtable-collaboration` |
| Obtain independent opinions without anchoring | `blind-peer-review` |
| Resolve conflicting findings with reasons and evidence | `evidence-adjudication` |
| Check hashes, schemas, finding coverage, and approval syntax | `artifact-verification` |
| Build and verify a self-contained transfer package | `handoff-packaging` |

Use the minimum set of lanes. If the request is a full workflow, initialize the workspace, freeze the exact review input, run collaboration or blind review, adjudicate every disclosed finding, verify, obtain named acceptance, then package. Never describe packaging as delivery; v0.1 has no upload or delivery API.

## Authority rules

1. Current project files and committed event records outrank conversational recollection.
2. A model contribution is a hypothesis until independently checked or adjudicated.
3. Agreement count is not evidence weight.
4. Deterministic checks cannot establish a scientific conclusion.
5. Any change to a frozen source invalidates dependent verification and requires a new packet.
6. A replacement packet must explicitly `supersede` its active predecessor; history is never rewritten.
7. Provisional review and `HUMAN_REVIEW_QUEUE.md` preserve momentum but cannot establish acceptance or authorize packaging.

Read [route-map.md](references/route-map.md) only when a request spans multiple lanes.
