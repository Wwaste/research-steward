# Workspace contract

Initialization is idempotent. Existing non-empty canonical files are preserved. Missing directories may be recreated, but committed events are immutable.

Project identity lives in `.research/manifest.json`. A project has exactly one root, protocol version, project ID, and creation time. Paths stored in events are root-relative POSIX paths; absolute paths and credentials are forbidden.

`STATUS.md`, `DECISIONS.md`, and `ROUND_TABLE.md` are materialized views. When a view conflicts with a valid event, the event wins and the view must be regenerated.

Packet generations are explicit. A new packet may `supersede` an existing active packet exactly once; the old packet remains immutable and still receives byte-integrity checks. Only active packet generations require current-source freshness.

Reads validate the complete event sequence and durable ledger head. A mismatch fails loudly. v0.1 provides no general ledger repair or history-rewrite command.
