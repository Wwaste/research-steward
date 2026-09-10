---
name: citation-integrity
description: Separate citation existence, metadata match, claim support, and retraction status. Use when references carry argumentative weight; offline mode must mark not_checked.
---

# Citation Integrity

**Required inputs:** bibliography entries and the sentences they support.

**Do not infer** support from title similarity alone; do not treat network failure as "no retraction".

## Four independent gates
1. **Existence** — identifier resolves or is marked not_checked.
2. **Metadata** — authors/year/venue match.
3. **Support** — cited passage actually supports the local claim.
4. **Retraction/correction** — checked with timestamp or explicitly not_checked.

## Output
`profile: "citation-integrity"`, per-gate status, `verdict`.
