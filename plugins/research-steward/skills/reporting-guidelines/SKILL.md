---
name: reporting-guidelines
description: Map manuscript sections to selectable CONSORT/STROBE/PRISMA-style checklists without treating checklist completion as scientific correctness. Use when preparing a reporting audit; it does not certify the science.
---

# Reporting Guidelines

**Trigger:** manuscript or protocol claims adherence to a reporting guideline.

**Required inputs:** guideline identity, completed checklist if any, and manuscript outline.

**Do not infer:** that a filled checklist implies valid methods or honest numbers.

## Profiles
- **CONSORT** — randomized trials (flow diagram, allocation, harms).
- **STROBE** — observational studies (design, participants, bias, limitations).
- **PRISMA** — systematic reviews (search, risk of bias, synthesis).

## Checks
1. Guideline named and versioned.
2. Each checklist item maps to a section or is `not_applicable` with reason.
3. Missing items are disclosed, not silently omitted.
4. Explicit note: checklist ≠ scientific correctness.

## Output
`profile: "reporting-guidelines"`, `guideline`, `items[]`, `verdict`.

## References
- [references/checklist-map.md](references/checklist-map.md)
