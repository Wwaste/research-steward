---
name: claim-evidence-audit
description: Map each manuscript claim to evidence locators and disposition strength without majority-voting truth. Use when coverage of claims is audited; it does not adjudicate disputed science alone.
---

# Claim–Evidence Audit

**Required inputs:** claim list, evidence locators, finding dispositions.

**Do not infer** support from multiple weak agreeing models.

## Checks
- Each claim has ≥1 locator or is marked uncovered.
- Claim type matches evidence type (descriptive vs causal).
- Contradicting evidence is listed, not only supporting.
- Dispositions require named authority; authors cannot self-adjudicate.

## Output
`profile: "claim-evidence-audit"`, coverage map, `verdict`.
