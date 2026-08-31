# Prior-art review

No single reviewed repository covered the full target: a research steward with discoverable subskills, immutable frozen evidence, automatic center-spoke collaboration, blind barriers, evidence adjudication, deterministic verification, handoff identity, and MCP access.

The closest reusable projects are:

- [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) (MIT): local research workspace, project files, provenance, and export.
- [pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT): councils, review loops, evidence lanes, budgets, and delivery receipts.
- [K-Dense Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills) (MIT): broad scientific skill coverage.
- [Nature Skills](https://github.com/Yuan1z0825/nature-skills) (Apache-2.0): short routers, sibling skills, references, scripts, and shared explicit-only support.
- [Agent Skills](https://github.com/agentskills/agentskills) (Apache-2.0): portable skill structure.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): MCP server and transport implementation.

Research Steward occupies the missing integration layer. It does not copy these frameworks or attempt to replace their model runtimes.

## Why not reuse `yylo-dev/roundtable`

[yylo-dev/roundtable](https://github.com/yylo-dev/roundtable) is a useful concept demonstration for wrapping local AI CLIs with MCP, but it is not a durable roundtable protocol. Its README claims MIT while `pyproject.toml` names AGPLv3, the repository has no root LICENSE, and GitHub reports no detected license. The reviewed implementation also lacked immutable event storage, frozen packet hashes, blind barriers, structured adjudication, deterministic gates, and delivery identity. Research Steward therefore copies none of its code.

## Deliberate non-goals in v0.1.0

- Replacing LangGraph, Microsoft Agent Framework, Pi, or another general agent runtime.
- Free-form agent group chat with unbounded feedback loops.
- Storing hidden chain-of-thought.
- Treating model consensus as scientific truth.
- Uploading or delivering packages without a separate authorized operation.
- Automatically discovering credentials or falling back to a metered API.
