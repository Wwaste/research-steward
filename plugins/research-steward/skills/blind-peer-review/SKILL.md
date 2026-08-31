---
name: blind-peer-review
description: Coordinate independent, mutually blind reviews of an immutable research packet and reveal them only after the review barrier closes. Use when avoiding anchoring, correlated mistakes, or model imitation matters.
---

# Blind Peer Review

Freeze one common packet and reviewer briefs before dispatch. Reviewers may read the packet and their own private work only. They must not read peer events, synthesized concerns, or a prior reviewer conclusion before committing their report.

Run blind work through `research_run_roundtable`. Manual MCP turns accept only `shared` or `private` visibility, and there is no manual barrier-close tool. The governed workflow creates the reviewer roster, enforces blind-group dependencies, and records the barrier as complete or blocked after every required reviewer reaches a terminal result.

Each report records severity, claim, evidence locator, reasoning summary, uncertainty, and remediation. Finding IDs must be unique across the project; roundtable output is automatically namespaced by node ID. Do not collect hidden chain-of-thought.

Comparison and adjudication happen only after the governed barrier is complete. Any adjudication of a blind group must depend on every disclosed report, and no reviewer may authoritatively adjudicate its own finding. Do not rewrite reports to make them agree.

Read [blindness-contract.md](references/blindness-contract.md) before dispatching reviewers.
