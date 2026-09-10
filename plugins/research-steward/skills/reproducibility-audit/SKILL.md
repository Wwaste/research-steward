---
name: reproducibility-audit
description: Check whether a frozen packet can be re-run from declared commands, environments, and seeds. Use before claiming reproducibility; it does not execute unapproved commands.
---

# Reproducibility Audit

**Required inputs:** run commands, environment lock, seeds, expected outputs/hashes.

**Do not infer** that a green notebook means deterministic rerun.

## Checks
- Entry-point commands are explicit (no shell interpolation secrets).
- Environment pinned (lockfile/modules) or gap declared.
- Random seeds recorded where relevant.
- Expected artifact hashes listed for comparison.

## Output
`profile: "reproducibility-audit"`, `verdict`, `findings[]`.
