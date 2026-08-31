# Handoff contract

A handoff package is reproducible from its manifest and archive alone. It excludes credentials, provider sessions, uncommitted temporary files, caches, raw hidden reasoning, and unrelated private data.

The clean-room check extracts with the host `tar` implementation into a fresh same-host temporary directory. It rejects entry-set mismatches, traversal, symbolic links, hard links, special files, size mismatches, and hash mismatches. This is local package verification, not isolation in a separate container or trust domain.

The v0.1 protocol records `packaged` only. Transfer and destination verification are external operations and must not be represented as implemented Research Steward events or APIs.
