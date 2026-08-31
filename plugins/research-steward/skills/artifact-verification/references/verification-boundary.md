# Verification boundary

Implemented machine-verifiable gates include file existence, schema validity, event and packet hashes, active-packet source freshness, project-wide disclosed-finding coverage, archive extraction, and absence of forbidden files.

`research_verify_project` parses declared commands but does not execute them, so command success and numeric tolerances require separate execution evidence. Human or scientific gates include estimand choice, interpretation, novelty, causal validity, domain acceptability, and risk acceptance. Mark those as named approvals; never encode them as a command that simply returns zero.

Every required approval must bind the same passing verification event ID and event hash. Formal acceptance additionally binds the exact `ACCEPTANCE.yaml` bytes and a normalized approval snapshot. Provisional review does neither.
