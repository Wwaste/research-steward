---
name: evidence-adjudication
description: Adjudicate frozen findings from multiple research reviewers with explicit evidence-weighted dispositions. Use when reports conflict, overlap, or require a traceable decision rather than majority voting.
---

# Evidence Adjudication

Work from frozen reports and the exact reviewed packet. For every disclosed completed finding, record one disposition: `accept`, `partial`, `reject`, or `defer`. Verification remains blocked while any such finding lacks a disposition.

The record must name the finding ID, rationale, supporting or contradicting evidence locators, affected artifact, required action, owner, and what evidence would change the decision. Finding IDs are unique across the entire project; roundtable-generated IDs are namespaced by workflow node. Count corroboration only after checking independence; repeated claims from shared context are not independent evidence.

An actor cannot commit the authoritative disposition of a finding it authored. For blind findings, use the run ID and depend on every report named by the completed barrier; do not construct a manual blind event or barrier. Do not send the synthesis back to reviewers and later present the result as independent. Do not let an adjudicator silently edit the scientific artifact; accepted changes remain separate tasks until implemented and reverified.

Read [evidence-weighting.md](references/evidence-weighting.md) for conflict handling.
