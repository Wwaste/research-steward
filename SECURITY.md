# Security model

## Trust boundary

Research Steward treats prompts, model output, project files, and MCP clients as untrusted input. A configured project root is the maximum filesystem authority. Paths are resolved through real paths and must remain inside that root after symlink resolution.

## Non-negotiable controls

- No shell interpolation for provider commands.
- No secrets in plans, events, generated views, logs, fixtures, or Git history.
- Bounded prompt, output, event, path, node, retry, and wall-clock sizes.
- Atomic writes in the destination directory and immutable committed events.
- Explicit allowlist for environment variables forwarded to provider CLIs.
- Local MCP uses stdio. HTTP mode requires a bearer secret and explicit host/origin allowlists.
- HTTP binds to loopback unless an operator deliberately supplies one exact private-interface address. Never use a wildcard bind for remote mode; verify the listener matrix and public-interface refusal again after a cold boot.
- Packaging creates and verifies a local archive only; v0.1 has no upload or delivery API.

## Identity and visibility limits

The HTTP bearer authenticates one coordinator endpoint. It does not cryptographically bind a request to the `actor.id` stored in an event. Actor IDs are attributable protocol claims within a trusted team, not participant credentials.

Direct HTTP on an exact Tailscale address relies on the tailnet's WireGuard transport, membership, and access policy; it does not add application-layer TLS. Keep the bearer requirement, host allowlist, exact-address bind, firewall checks, and public-interface refusal. A successful probe from one tailnet peer proves that peer's route, not the full control-plane ACL policy, which must be reviewed separately.

Likewise, `blind` and `private` are enforced at provider prompt construction, shared materialized views, and MCP event listing. The coordinator process and the operating-system account can still read the authoritative ledger. Remote HTTP mode is therefore not a safe multi-tenant service for mutually untrusted participants.

`research_get_status` reports minimal identifiers for unresolved private blockers—event ID, type, actor ID, timestamp, visibility, and optional run ID—so private work cannot invisibly deadlock a shared project. It does not disclose the private summary, evidence, findings, or uncertainty text through that status response.

## Provider host boundary

Provider processes receive a minimal environment but retain the existing subscription client's home-based authentication state. They run in a sealed temporary working directory. Qoder has tools, MCP, plugin discovery, and persisted sessions disabled; Kimi is not permitted in blind lanes because the same denial cannot currently be proven.

Kimi prompts currently appear in process arguments, so run that adapter only on a trusted single-user host. Qoder receives prompts over stdin. Grok uses a protected prompt file and explicitly does not inherit `XAI_API_KEY`, preventing a silent switch from the subscription route to separately metered API billing.

The sealed temporary working directory and reduced environment are not an OS sandbox. Provider processes still execute as the Research Steward service account and may use whatever that account can access outside the project protocol. The HTTP transport closes on client disconnect, but an already-started provider child is not currently cancelled by that disconnect. Do not expose provider execution to mutually untrusted clients.

## Integrity limit

SHA-256 chains detect accidental corruption and unsanctioned edits under the protocol, but they are not digital signatures or an external transparency log. A malicious actor with write access to the project and all protocol metadata remains inside the local trust boundary.

Finding IDs are project-wide unique, workflow output is node-namespaced, and an actor cannot author and authoritatively adjudicate the same finding. Verification requires dispositions for disclosed completed findings, but these are governance invariants, not proof that a scientific judgment is correct.

## Verification and packaging limits

`research_verify_project` parses acceptance-command declarations but does not execute them. A passing verification therefore means that implemented structural gates passed; it is not evidence that an arbitrary build, analysis, or scientific command ran.

Packaging invokes the host's `tar` binary and verifies the archive in a fresh temporary directory on the same host, not in a container or separate security domain. It accepts only an explicit allowlist of at most 1,000 regular files, with a 512 MiB per-file and 2 GiB total payload limit; archive creation/extraction has a 120-second command deadline. Exact entry-set, size, hash, symlink, hard-link, traversal, and special-file checks reduce archive risk, but this is not a general untrusted-archive inspection service.

Ledger operations validate the full event chain, and verification scans the full frozen-packet set. This is intentionally fail-closed but can become expensive for very large projects; v0.1 has no index/checkpoint acceleration.

## Acceptance boundary

A provisional review is an attention marker only. Neither a `provisional_review` event nor `HUMAN_REVIEW_QUEUE.md` establishes acceptance or permits packaging. Formal acceptance requires named approvals that bind the same passing verification event ID and hash; the acceptance event also binds the exact approval document bytes and normalized approval snapshot.

## Reporting vulnerabilities

Open a private GitHub security advisory after publication. Do not include credentials or private research data in a public issue.
