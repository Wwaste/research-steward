---
name: handoff-packaging
description: Build and same-host clean-room verify a self-contained Research Steward archive with hashes and provenance. Use to prepare accepted bytes for a later transfer; v0.1 packages locally and does not upload or verify delivery.
---

# Handoff Packaging

Package only explicit allowlisted paths. Generate `HANDOFF_MANIFEST.yaml` with protocol version, project ID, packet and event identities, relative paths, sizes, SHA-256 values, creation time, and excluded sensitive classes.

Packaging requires a formal acceptance bound to a passing verification and an accepted frozen packet whose file set exactly matches the request. A provisional review or `HUMAN_REVIEW_QUEUE.md` entry cannot authorize it.

Verify the archive in a fresh temporary directory on the same host. Ensure every manifest file exists and matches its hash, the exact entry set contains only regular allowlisted payload files, no absolute or traversal path is embedded, and no companion secret or local state is required. The implementation uses the host `tar` binary and enforces its documented file-count, size, and timeout limits.

Mark only the implemented result, `packaged`. External upload, destination receipts, and delivery verification are outside the v0.1 API and require a separately authorized workflow.

Read [handoff-contract.md](references/handoff-contract.md) before creating a public or external package.
