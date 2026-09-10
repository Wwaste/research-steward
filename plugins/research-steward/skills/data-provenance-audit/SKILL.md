---
name: data-provenance-audit
description: Trace a packet's datasets and artifacts to frozen sources, hashes, and transform steps. Use when lineage must be auditable; it does not recover missing provenance.
---

# Data Provenance Audit

**Required inputs:** packet manifest, dataset locators, transform scripts.

**Do not infer** unrecorded downloads or silent schema edits.

## Checks
- Every analysis input has a locator and hash or declared gap.
- Transforms are versioned or scripted, not manual-only.
- Derived tables reference source packet IDs.

## Output
`profile: "data-provenance-audit"`, `verdict`, `findings[]`.
