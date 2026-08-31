# Multi-lane route map

A full run has explicit gates:

1. Workspace: objective, scope, constraints, inputs, acceptance.
2. Freeze: exact bytes and SHA-256 manifest are immutable. A replacement explicitly `supersedes` active prior packet IDs.
3. Review: open collaboration or governed blind review. Manual MCP turns cannot create blind events or barriers.
4. Adjudication: every disclosed completed finding receives one disposition and rationale from an actor other than its author.
5. Verification: structural checks cover the full event chain, active source freshness, and finding dispositions. Declared commands are parsed but not executed.
6. Acceptance: each required named authority binds the same passing verification event ID and hash. Provisional review only creates a human-attention item.
7. Packaging: accepted frozen bytes, manifest, and same-host clean-room archive are reproducible.

Stop on missing authority, ambiguous scope that changes the scientific estimand, failed hash verification, exhausted budget, repeated provider failure, or a blocked dependency.

`candidate_declared`, `delivery_recorded`, and `delivery_verified` are reserved names, not v0.1 workflow gates or callable APIs. External transfer is outside this route map.
