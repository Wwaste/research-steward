---
name: research-contract
description: Freeze a versioned research contract (question, estimand, population, exposure, outcome, unit, data cut, exploratory vs confirmatory) before analysis claims. Use at packet freeze; contract changes require a new packet.
---

# Research Contract

**Required inputs:** scientific question, design profile, data cut identity.

**Do not infer:** post-hoc confirmatory status, silent empty-string N/A fields.

## Profiles
- `general` | `experimental` | `observational` | `model_simulation` | `literature_review`

## Rules
1. Every field is either a value or `{ not_applicable: true, reason }`.
2. Experimental contracts require intervention and comparator.
3. `analysis_class` is `exploratory` or `confirmatory` and must match claim language.
4. Contract hash is part of freeze identity; change ⇒ new packet.

## Output
Frozen contract JSON matching `schemas/research-contract.schema.json` and a `contract_hash`.
