---
name: research-question-audit
description: Check whether a packet's question, estimand, and claim scope are coherent and match the data cut. Use before analysis claims; it does not invent a research question.
---

# Research Question Audit

**Required inputs:** stated question, estimand, population, data cut identity.

**Do not infer** unstated primary outcomes or post-hoc primary questions.

## Checks
- Question is answerable with the named data cut.
- Estimand (population, outcome, contrast, time) is complete.
- Exploratory vs confirmatory labeled.
- Scope of the claim does not exceed the question.

## Output
`profile: "research-question-audit"`, `verdict`, `findings[]`.
