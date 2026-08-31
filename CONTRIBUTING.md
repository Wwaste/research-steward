# Contributing

Contributions are welcome when they preserve the protocol boundary: immutable authority, explicit identity, bounded execution, no hidden credential discovery, and no model-voting shortcut.

Before opening a pull request:

```bash
cd plugins/research-steward
npm ci
npm run check
npm audit --audit-level=moderate
node scripts/smoke-mcp.mjs
node scripts/smoke-http.mjs
```

Add a regression test for protocol, security, or recovery changes. A provider claiming success is never a substitute for a deterministic test. Do not commit research data, provider transcripts, tokens, private hostnames, private IPs, or client configuration containing credentials.

For new skills, keep `SKILL.md` short and route detailed contracts into directly referenced files. Shared support skills must remain non-implicit.
