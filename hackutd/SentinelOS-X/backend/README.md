# backend/ — planned (Phase 2), not implemented

Optional FastAPI service acting as a SpacetimeDB client with its own identity, for work that must hold server-side secrets (e.g. NVIDIA API keys) or call external services. It will write to SpacetimeDB only through permission-checked reducers. Nothing in Phase 1 depends on this directory.
