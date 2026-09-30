# Classification and optional suggestions

Profe applies local merchant rules before provider categories when importing or reclassifying transactions. Manual corrections and splits remain independent and authoritative. The normal ledger needs no AI provider.

To enable optional on-demand suggestions, configure `LLM_BASE_URL` (HTTPS OpenAI-compatible API base, such as a provider's `/v1/` URL), `LLM_MODEL`, and server-side `LLM_API_KEY` or `LLM_API_KEY_FILE`. Choose a small inexpensive model supporting JSON responses. Never put these credentials in the frontend. No provider is enabled by default.

The transaction editor's suggestion action creates a durable PostgreSQL `classification_jobs` entry and attempts it immediately. Only the first 120 description characters (long digit sequences redacted) and the available category labels are sent. The model receives no amount, date, account identifier, bank balance, or transaction ID. Merchant descriptions and custom category labels may still be sensitive; enabling a provider permits sending these selected fields to it.

Jobs are keyed by data mode, canonical transaction ID, and a fingerprint of the description, category list, endpoint, model and a one-way credential digest. Successful suggestions are cached; repeated requests and concurrent workers share one job. Errors persist only a fixed safe code, never provider response bodies or API credentials. Pending jobs survive restart; a 30-second worker retries due jobs with exponential delays starting at one minute, at most five attempts. Credential values are not persisted in jobs. Correcting or rotating the credential creates a new job identity, allowing exhausted requests to retry without persisting the credential itself.

Suggestions always require explicit user review and saving. They never mutate ledger classification, corrections, splits, or budgets by themselves. A provider outage returns a safe retry message; imported transactions, manual edits and budgets remain usable. Input changes invalidate an outstanding job; requesting again creates a fresh job. Exhausted jobs remain failed, with manual classification available.

This MVP has an **on-demand suggestion queue**, not automatic AI classification of every imported transaction. The regular review queue and rule engine remain the primary workflow. There is no bulk AI job UI or automatic acceptance. The durable queue and attempt counts are available to the operator in PostgreSQL; they are included in full database backups.
