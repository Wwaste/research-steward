# State semantics

Implemented v0.1 progression is `draft -> frozen -> reviewing -> adjudicated -> verified -> accepted -> packaged`. Revising a frozen artifact creates a new generation rather than mutating history.

Any event with blocked status enters the project into `blocked`. Ordinary later contributions cannot clear it. A complete `block_resolved` event must explicitly depend on every blocking event being resolved; unresolved blockers remain active. When all are resolved, the view returns to the last stable pre-block state and a fresh verification or acceptance event can advance it.

`candidate_declared`, `delivery_recorded`, and `delivery_verified` are reserved event names. Their first-class transition, authorization, receipt, and verification APIs are not complete in v0.1.

A `provisional_review` does not advance the stable state. It records a low-authority review of the current passing verification and adds human attention metadata. Formal acceptance still requires named approvals in `ACCEPTANCE.yaml` that bind the same verification event ID and hash. Packaging requires that formal acceptance; v0.1 has no delivery transition API.
