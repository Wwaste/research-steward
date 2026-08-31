# Provenance fields

Every contribution records event ID, sequence, run ID, actor ID, role, adapter, requested model, timestamp, frozen input hash, visible dependency IDs, content hash, status, evidence locators, and uncertainties. The protocol records concise reasoning summaries, not hidden chain-of-thought.

Roundtable findings use node-namespaced IDs and all finding IDs are unique across the project ledger. Acceptance provenance names the passing verification event ID and hash, the exact `ACCEPTANCE.yaml` byte hash, and a normalized required-approval snapshot hash. Provisional review provenance names its verification target but confers no authority.
