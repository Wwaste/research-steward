---
name: artifact-verification
description: Deterministically verify Research Steward project structure, schemas, hashes, active frozen packets, finding coverage, approval syntax, and state consistency. Use before claiming verification, acceptance, or packaging; it does not execute analysis commands or establish scientific truth.
---

# Artifact Verification

Use the verifier rather than relying on an agent's completion statement. It checks canonical files, event schemas, unique sequences, event hashes, packet hashes, dependency references, active-packet source freshness, and project-wide finding coverage.

`ACCEPTANCE.yaml` command declarations are parsed for syntax but are not executed by `research_verify_project`. Run any required build or analysis in a separately authorized workflow and retain its evidence. A structurally passing verification does not establish scientific correctness.

Any active reviewed source change invalidates dependent verification. Freeze a new packet with explicit `supersedes`, then rerun relevant checks. Do not mutate the old packet. Report `pass`, `fail`, `blocked`, and `not_applicable` separately.

Before formal acceptance, require every disclosed completed reviewer finding to have an authoritative disposition. A reviewer cannot adjudicate its own finding. A provisional review or generated `HUMAN_REVIEW_QUEUE.md` entry is attention metadata only and cannot authorize acceptance or packaging.

Read [verification-boundary.md](references/verification-boundary.md) when defining acceptance gates.
