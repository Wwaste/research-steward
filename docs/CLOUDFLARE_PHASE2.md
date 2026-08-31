# Cloudflare phase 2 plan

Phase 2 adds a stable domain only after the private Tailscale deployment is healthy. It is a separate security change, not a prerequisite for the v0.1 plugin release.

## Entry conditions

Do not start external configuration until all of these are true:

- the same immutable release has passed local tests, MCP smoke checks, and the deployed endpoint probe;
- the service has survived a VPS reboot and still binds only to loopback;
- the project-data backup and release rollback paths have been exercised;
- the intended domain, Cloudflare zone, permitted identities, and notification owner are explicitly chosen;
- a separate hostname is available for the MCP write endpoint;
- the operator has approved the external DNS, Tunnel, and Access changes.

The existence of a Cloudflare domain is not implementation authorization.

## Target boundary

```text
authorized MCP client
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> loopback reverse proxy
  -> Research Steward HTTP MCP
  -> explicitly allowlisted server-side project roots
```

Use separate hostnames and policies for different trust surfaces:

- a public or broadly shared documentation/status site is read-only and has no MCP write route;
- the MCP hostname is protected by Cloudflare Access and the Research Steward bearer token;
- origin services remain bound to loopback and are not opened on a public VPS interface.

Cloudflare Access authenticates a person or service identity. The Research Steward bearer token authenticates the coordinator endpoint. Neither mechanism turns actor IDs inside research events into cryptographic identities, so mutually untrusted tenants must not share one ledger endpoint.

## Design decisions to freeze before implementation

1. **Hostname ownership:** choose the exact documentation and MCP hostnames and record who controls the zone.
2. **Access policy:** choose allowed identities or service tokens, session duration, and emergency access owner.
3. **Client compatibility:** confirm which MCP clients can present both Access credentials and the Research Steward bearer token.
4. **Origin validation:** validate Cloudflare Access JWTs at the origin or with an authenticated proxy; never trust an unverified identity header.
5. **Host and Origin allowlists:** add only the final hostnames and browser origins. Non-browser clients should not require a permissive CORS wildcard.
6. **Logging boundary:** retain request metadata needed for operations without logging bearer tokens, Access assertions, frozen packet contents, or model prompts.
7. **Data location:** decide which projects are deliberately synchronized to the VPS. A remote endpoint does not grant access to laptop-only files.

## Implementation sequence

1. Export or record the current Cloudflare DNS, Access, and Tunnel state for rollback without storing secrets in Git.
2. Create a named Tunnel with credentials held by the VPS secret store and a dedicated service account.
3. Route the MCP hostname to a loopback-only reverse-proxy location; keep the direct Node port unreachable externally.
4. Create the Access application and least-privilege policy before publishing the DNS route.
5. Configure origin-side JWT verification and strict Host/Origin allowlists.
6. Publish the DNS route with a deliberately short initial TTL where Cloudflare permits it.
7. Run the test matrix below from an authorized client and an unauthorized context.
8. Preserve the Tailscale route during the observation window so it remains the recovery path.
9. After the observation window, document the stable configuration and rotate any one-time bootstrap material.

## Required test matrix

| Path | Expected result |
|---|---|
| Public network, no Access identity | Access denial; origin is not reached |
| Valid Access identity, no MCP bearer | HTTP `401` from Research Steward |
| Valid bearer, invalid or missing Access identity | Access denial |
| Valid Access identity and bearer, wrong Host | HTTP `403` |
| Browser request from an unlisted Origin | HTTP `403` |
| Fully authorized MCP initialization and `tools/list` | Success with exact service identity and required tool inventory |
| Authorized request for a non-allowlisted project root | Protocol-level root denial |
| Tunnel stopped | Public route fails closed; Tailscale recovery path still works |
| VPS reboot | Tunnel, proxy, and Research Steward recover without public-port exposure |

Also verify certificate status, Cloudflare audit events, service logs, and absence of credentials in logs after the probes.

## Rollback

Rollback must not modify research event files or frozen packets.

1. Disable the Cloudflare DNS route or Access application created for Phase 2.
2. Stop the Tunnel service and remove only its route from the loopback proxy.
3. Restore the recorded Host/Origin allowlists and previous proxy configuration.
4. Confirm that the Tailscale endpoint and local stdio plugin still pass their probes.
5. Revoke the Phase 2 Tunnel and service credentials if exposure is suspected.
6. Record the reason, timestamps, and verification evidence in the operator handoff.

## Explicit non-goals

- No standalone AI group-chat website is required.
- No public anonymous MCP endpoint is supported.
- No automatic import of every Cloudflare account, zone, or project is allowed.
- No DNS, Tunnel, Access, or certificate mutation occurs as part of the v0.1 release.
- No Cloudflare control-plane credentials belong in plans, events, packages, or the public repository.
