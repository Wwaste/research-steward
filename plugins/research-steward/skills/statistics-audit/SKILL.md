---
name: statistics-audit
description: Audit statistical claims in a frozen research packet — effect sizes and confidence intervals, power, assumptions, missing data, multiplicity, data leakage, and sensitivity analyses. Use when a claim depends on inference; it does not recompute the study or establish scientific truth.
---

# Statistics Audit

**Trigger:** a packet claims an effect, association, p-value, CI, or model metric.

**Required inputs:** analysis code or methods text, reported numbers, sample sizes, and the claim under audit.

**Do not infer:** unreported tests, post-hoc power from observed effect alone as proof of design adequacy, or that a checklist pass means the statistics are correct.

## Checks
1. **Effect size and uncertainty** — report point estimate with CI; do not treat p < 0.05 as the claim.
2. **Power / sample size** — distinguish a priori design power from post-hoc observed power.
3. **Assumptions** — independence, distributional form, variance structure; name what was tested vs assumed.
4. **Missing data** — mechanism (MCAR/MAR/MNAR), complete-case vs imputation, sensitivity to that choice.
5. **Multiplicity** — families of tests, corrections used or explicitly waived, exploratory vs confirmatory.
6. **Data leakage** — train/test contamination, outcome-informed feature selection, peeking at holdout.
7. **Sensitivity analysis** — which analytic choices would flip the conclusion; were they run?

## Output schema (summary)
```json
{
  "profile": "statistics-audit",
  "verdict": "pass | fail | blocked | not_applicable",
  "findings": [{ "id": "STAT-###", "severity": "minor|major|critical", "claim": "...", "evidence_locator": "...", "remediation": "..." }]
}
```

## References
- [references/checklist.md](references/checklist.md)
- Load `research-shared` for disposition and provenance terms.
