---
name: project-workspace
description: Initialize or inspect canonical Research Steward project files and derive status from the immutable ledger. Use when starting a research task, handing work between agents, or resuming a governed roundtable; v0.1 has no general repair API.
---

# Project Workspace

Use the MCP initializer when available. It creates `STATUS.md`, `TASK.md`, `DECISIONS.md`, `ACCEPTANCE.yaml`, `HANDOFF_MANIFEST.yaml`, and `.research/` state without replacing non-empty user files.

After initialization:

1. Put the concrete objective, exclusions, inputs, and authority boundary in `TASK.md`.
2. Make every automated gate explicit in `ACCEPTANCE.yaml`.
3. Record decisions as additive entries; correct an old decision by superseding it.
4. Derive status from valid committed events. Do not advance state by editing `STATUS.md` alone.
5. Treat a ledger/hash failure as a blocking integrity error. Do not hand-edit event files or claim that v0.1 can repair them.

When reviewed source changes, freeze a new packet and explicitly name active prior packet IDs in `supersedes`; never replace the old frozen bytes. Read [workspace-contract.md](references/workspace-contract.md) before interpreting project authority.
