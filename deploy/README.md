# Private VPS deployment

Remote deployment is optional. Local stdio remains the preferred client path. Use a VPS only when the authoritative project root is actually present there and multiple clients need the same durable ledger.

The hardened v0.1 VPS unit is a ledger/MCP deployment: initialize projects, freeze packets, append shared/private turns, inspect status, adjudicate, verify, record provisional or formal review, resolve blockers, and package accepted bytes. It does not promise remote provider execution. The checked-in unit uses `ProtectHome=true`, so home-based Qoder/Kimi/Grok authentication is unavailable; provider-backed roundtables will not work unless an operator deliberately creates a separate provider-enabled deployment with installed CLIs, explicit authentication storage, and a revised threat model.

## Adopted deployment pattern

The deployment borrows the useful parts of a proven two-slot web workflow: immutable release directories, a stable `current` symlink, a fixed service entrypoint, health checks before promotion, and an old release retained for rollback. It does not reuse the web UI or public domain because Research Steward has no standalone browser interface.

Recommended layout:

```text
/opt/research-steward/releases/<release-id>/
/opt/research-steward/current -> releases/<release-id>
/etc/research-steward/research-steward.env
/srv/research-steward/projects/
```

Create a dedicated unprivileged service account, copy one immutable release, verify the committed bundle hash, atomically replace `current`, install `research-steward.service`, and start it. Generate the bearer token with `openssl rand -hex 32`. The environment file must be mode `0600`; never put its bearer token in Git, a URL, a plan, or a generated event. The server rejects the checked-in placeholder and other low-confidence token shapes. Keep the default unit provider-free; do not weaken `ProtectHome` merely to reuse a personal CLI login.

## Private Tailscale exposure

Choose exactly one exposure mode. Do not combine a direct Tailscale bind with a Serve route for the same service.

### Mode A: loopback plus Tailscale Serve

When tailnet HTTPS certificates are enabled, keep Node on loopback and let Serve terminate HTTPS:

```bash
tailscale serve --bg --yes --https=443 --set-path=/research-steward http://127.0.0.1:8799
```

The endpoint is `https://<tailnet-dns-name>/research-steward/mcp`. Confirm the route with `tailscale serve status --json` and separately prove that Funnel is disabled. A host whose Nginx or another daemon binds an exact tailnet address needs a cold-boot coexistence test; do not keep Serve if any existing service fails after reboot.

### Mode B: exact Tailscale-address bind

Use this mode when the host already treats Nginx or other services as the tailnet entry layer, or when Serve cannot coexist cleanly. Set `RESEARCH_STEWARD_HTTP_HOST` to the host's exact Tailscale address, choose a dedicated unoccupied high port, keep a strict `RESEARCH_STEWARD_ALLOWED_HOSTS`, and verify that the same port has no loopback, public-address, or wildcard listener.

Starting `tailscaled.service` does not prove that its address is ready. If the host provides `tailscale-wait-online.service`, first inspect it and then install the optional drop-in:

```bash
systemctl cat tailscale-wait-online.service
install -D -m 0644 deploy/research-steward-tailscale.conf.example \
  /etc/systemd/system/research-steward.service.d/tailscale.conf
systemctl daemon-reload
```

Any Nginx unit that binds an exact tailnet address needs the equivalent `Wants=` and `After=` dependency. Keep generic service templates independent of Tailscale; add the dependency only on hosts that use direct-tailnet mode.

The direct endpoint is `http://<tailnet-dns-name>:<private-port>/mcp`. Traffic between tailnet members is protected by Tailscale/WireGuard, but this mode has no application-layer TLS. Never route it outside the tailnet, and keep the bearer token, exact bind, host allowlist, firewall posture, and public-interface refusal as separate controls. A peer probe does not by itself audit the tailnet's control-plane ACL policy.

For either mode, keep the bearer token in the client's secret store or environment injection mechanism. `/healthz` proves only that the process and host allowlist are working; an authenticated MCP `tools/list` call is required to prove the full client path. Run the repository probe after promotion, injecting the chosen endpoint and token without placing the token in shell history or command output:

```bash
cd plugins/research-steward
RESEARCH_STEWARD_ENDPOINT=<chosen-private-endpoint-ending-in-/mcp> \
RESEARCH_STEWARD_HTTP_TOKEN=<injected-secret> npm run probe:http
```

After a cold boot, repeat the authenticated probe, a second tailnet peer's health/`401` probe, listener classification, public-interface refusal, `failed_units` inspection, and all pre-existing service health checks.

## Promotion and rollback

1. Copy a new release to a new immutable directory.
2. Run local build, test, audit, plugin validation, and MCP smoke checks. The project verifier itself does not execute commands listed in `ACCEPTANCE.yaml`.
3. Start or validate the new release without changing the project root.
4. Atomically repoint `current` and restart the service.
5. Verify local health, tailnet health, unauthorized `401`, authenticated `tools/list`, listener scope, public-interface refusal, and service logs.
6. Retain the previous release and symlink target until the new service survives a reboot.

Rollback means repointing `current` to the previous release and restarting the service. It does not roll back project events: immutable research state is a separate data layer and must never be overwritten as part of a code rollback.

## Phase 2: optional Cloudflare domain

Cloudflare is not required for the first private release. Phase 2 is design-only in v0.1; no DNS, Tunnel, Access, certificate, or origin configuration is implemented by this repository. After the Tailscale-only service survives deployment and reboot checks, a separately authorized implementation may add a stable domain using:

```text
Cloudflare Access -> Cloudflare Tunnel -> loopback Nginx/service -> Research Steward MCP
```

The design review must cover Access application and policy ownership, Tunnel credentials, strict origin validation, bearer-token preservation, DNS and certificate rollback, and end-to-end unauthorized/authorized probes. A Cloudflare identity header must not be trusted unless the origin validates the Access JWT. Keep any read-only project or documentation site separate from the MCP write endpoint.

Do not commit account IDs, tunnel IDs, Access audience values, private hostnames, emails, credentials, or tokens. Do not change DNS, Tunnel, or Access state merely because a domain exists; external configuration requires an explicit implementation authorization.

## Cross-client friction

- Codex: install the plugin and prefer its stdio MCP server for local projects.
- Other MCP clients: use the same bundled `dist/server.mjs` over stdio, or configure the authenticated private endpoint selected above for shared server projects.
- Browser CORS: origins are denied unless explicitly listed. Non-browser MCP clients usually send no Origin header.
- Files do not teleport with the MCP connection. Synchronize or deliberately upload the authoritative project data before using remote mode.
- Client disconnect closes the MCP transport but does not currently cancel an already-started provider child process.
- Event and packet checks perform full scans; split unrelated long-lived research into separate project roots before ledger size becomes operationally expensive.
- The system `tar` binary is required for packaging. Clean-room extraction occurs on the same host and remains subject to the documented file-count, size, and timeout limits.
