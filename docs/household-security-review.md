# Household security review

Reviewed the named-account authentication, users/invitations, resource-access facade and HTTP routing changes against the existing financial and integration boundaries. Verification uses isolated PostgreSQL schemas and synthetic identities/credentials only.

Verified properties:

- First administrator requires a deployment-local random bootstrap proof. A persisted closed-bootstrap flag prevents signup reopening merely because all user rows are removed. First-account creation is serialized.
- No legacy shared-password cookie/hash fallback remains. Password hashing is asynchronous and concurrency-bounded; session rows retain token hashes only. Disabled users fail session lookup; password and access changes revoke sessions.
- Invitations and password reset tokens are hashed, expire and are single-use. Resend revokes prior tokens; activation rechecks validity inside the transaction. Fragment links avoid putting bearer tokens in the request URL. Public activation is rate limited and origin checked.
- User-management mutations recheck administrator privileges and preserve an active administrator. Recovery is a trusted local operator command, not a public HTTP feature.
- Financial routes use a request-scoped facade; settings, integration status/actions, global rules, delivery logs and user management remain administrator-only. On-demand remote classification is also administrator-only because its global category vocabulary could reveal hidden category names. Hidden IDs are rejected without returning hidden account rows. Account and budget grants are independent, and budget-only access exposes the deliberately granted summary without transaction IDs.
- Member report/export reads use the same database connection/snapshot for grant reads and calculations. Original transfer semantics survive presentation filtering and restricted edits; transfer descriptions, notes and audit are hidden where they could identify an ungranted account.
- External financial alerts require explicit administrator acknowledgement that their audience receives whole-household category summaries independently of app permissions. Existing notification configurations are gated until acknowledged. Revocation prevents queued financial delivery and does not replay old alerts when acknowledged again.

Review findings fixed during implementation: persisted bootstrap closure; public activation throttling and valid-token preflight before expensive password hashing; invalidating outstanding reset links after a manual password change; grant reads within the report/export transaction; an explicit notification audience gate; and preventing member AI suggestions from disclosing the global category vocabulary.

Targeted verification ran `household-auth.test.js`, `users.test.js`, and `access-api.test.js`: **4 tests passed, zero skipped**. Three notification tests also passed, including consent revocation, restart reservation, retries, concurrency and single-connection pools. The expanded native PostgreSQL backup/restore rehearsal passed across **29 tables**, including hashed authentication records and independent resource grants; financial totals remained unchanged.

This review does not claim a penetration test, formal proof, MFA/SSO support or production delivery verification. Demo authentication is intentionally fictional and must remain private; live deployments require trusted HTTPS and explicit first-administrator setup. A running process/database operator remains trusted. See the full test suite and browser verification for the final integrated result.
