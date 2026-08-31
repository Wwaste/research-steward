---
name: roundtable-collaboration
description: Run an attributable center-spoke research collaboration in which downstream AI nodes automatically read committed upstream work, respond through immutable events, and expose uncertainties. Use for producer-reviewer-revision loops and expert panels where interaction is desired.
---

# Roundtable Collaboration

Require a frozen input packet and a DAG plan. Each node must declare `actor_id`, role, adapter, model, brief, dependencies, visibility, timeout, and output limit.

The coordinator may start a node only after every dependency has a committed event. It supplies the frozen packet plus the selected dependency outputs, never an unbounded transcript. Every contribution must contain a result summary, evidence locators, explicit uncertainties, and a status of `complete` or `blocked`.

Roundtable output namespaces every reviewer finding ID with the node ID, preserving project-wide uniqueness. An adjudicator must disposition every and only finding received through its dependencies, and cannot adjudicate a finding authored by the same actor ID.

Use directed critique rather than unrestricted chatter. Set maximum nodes, retries, wall time, prompt size, and output size before launch. Stop when acceptance is satisfied, no runnable nodes remain, a blocker needs user authority, or the budget is exhausted.

Use `research_run_roundtable` for blind or mixed plans. Manual MCP turns support only shared/private collaboration and cannot construct a blind roster or disclosure barrier. The provider boundary is a sealed cwd and reduced environment, not an OS sandbox; closing an HTTP client does not cancel an already-started provider process.

The default hardened VPS service is ledger-only because `ProtectHome=true` hides subscription CLI authentication. Run provider-backed roundtables on a trusted local host or a separately designed provider-enabled deployment; do not assume the v0.1 VPS unit can call Qoder, Kimi, or Grok.

Read [open-protocol.md](references/open-protocol.md) when designing a new roundtable DAG.
