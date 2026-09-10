---
name: bias-validity-audit
description: Separate confounding, selection, measurement, information-leakage, external-validity, and causal-claim boundaries in a frozen packet. Use when a claim may overreach design; it does not prove absence of bias.
---

# Bias and Validity Audit

**Trigger:** causal or generalization language on observational or limited designs.

**Required inputs:** design description, sampling frame, measurement procedures, and the claim text.

**Do not infer:** that adjustment eliminates unmeasured confounding, or that a DAG was considered if none is recorded.

## Bias classes
- **Confounding** — common causes of exposure and outcome; what was measured/adjusted.
- **Selection** — inclusion, attrition, collider bias.
- **Measurement** — misclassification, instrument validity, blinding.
- **Information leakage** — outcome or label info available at decision time.
- **External validity** — population vs sample; transport assumptions.
- **Causal boundary** — wording must match design (RCT vs cohort vs case series).

## Output
Same shape as statistics-audit with `profile: "bias-validity-audit"`.

## References
- [references/claim-boundaries.md](references/claim-boundaries.md)
