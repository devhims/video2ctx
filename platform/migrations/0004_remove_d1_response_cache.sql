-- YouTube response caching moved to Workers KV. This table contained only
-- reproducible upstream cache entries, never application source-of-truth data.
DROP TABLE entity_snapshots;
