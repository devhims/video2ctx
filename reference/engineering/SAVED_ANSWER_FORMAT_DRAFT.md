# Deferred saved-answer formatting

This draft builds on the saved-evidence reader PR. It is intentionally separate from the evidence-recovery fix and is not recommended for deployment without a product decision about presentation failures.

The proposed `set_verification_requirements` tool records user requirements and four structured preferences: the current name, numbered-point count, whether only numbered points are permitted, and whether code must be fenced. The record is checkpointed before acknowledgment and restored for finalization recovery.

The application renders point numbers and safe code fences, then validates the answer before and after citation rendering. Nested steps remain valid. Explicit constraints receive one repair attempt; a remaining violation fails the run. An unconstrained handoff does not disable supported partial fallback.

That failure policy is the unresolved tradeoff. It can prevent a supported evidence answer from reaching the user because of presentation drift. Prompt guidance or a non-blocking warning may be preferable. The base PR keeps those simpler semantics and does not include this checkpoint or validator.

Tests cover checkpoint persistence and failure, resumed finalization, nested numbering, code fences, citation placement and constrained versus unconstrained fallback. Exact-session fixtures are shared with the base PR; this draft restores strict presentation assertions for evaluating the proposal separately.

Local validation: the platform build, 2,163 unit tests and 437 Worker integration tests passed. The stricter live replay is reported in the draft PR description.
