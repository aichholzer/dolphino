# Database-only integration settings upgrade

## What changes

An administrator now manages all integration configuration in Settings. PostgreSQL is the sole runtime source for:

- Redbark API key, API version, rolling backfill window and destination signing secret
- Classification provider, model, provider credentials, Bedrock region, master enable switch, automatic-suggestions switch, automatic-application switch, daily request limit and batch size
- The independent read-only assistant configuration and encrypted credentials
- Telegram/SMTP configuration and credentials

OpenAI and Bedrock use fixed secure provider URLs. Custom LLM base URLs are unsupported. All former Redbark and LLM environment variables, including their secret-file variants, are ignored. There is no environment fallback, first-start import or automatic migration of secrets from the environment. Environment-only integrations therefore pause until an administrator explicitly configures them in Settings.

Deployment configuration remains outside the database: PostgreSQL `PG*` connection/TLS settings, deployment mode, HOST/PORT, APP_BIND, APP_ORIGIN, first-administrator bootstrap proof and APP_SECRET. Currency and timezone environment settings remain defaults. Keep the existing deployment configuration and data volume unchanged.

## Safe upgrade checklist

1. Stop the app and take a PostgreSQL backup. Keep a separate protected backup of the existing APP_SECRET and record the application version. Never print or commit credentials.
2. Upgrade against the same live database, database user and volume. Do not seed it, switch it to demo mode, create a replacement volume or regenerate APP_SECRET. Existing imported observations/transactions, overrides, rules, budgets, webhook receipts, jobs, users, notification settings and outbox records remain in place.
3. Start the upgraded app and sign in as an administrator. Stored financial data and manual work remain available while unconfigured integrations are paused.
4. In **Redbark settings**, explicitly re-enter the former environment API key, API version and rolling backfill days, then save. Default rolling history is 90 days, bounded to 1–2555. A blank secret field preserves the saved ciphertext; selecting Clear sends an explicit removal. Run **Test connection** for the saved API key/version before imports can resume.
5. Existing encrypted Redbark signing-secret rows remain intact. API-key changes invalidate their association so an old destination cannot authorize events for another account. Register/reuse or recover the matching destination, or explicitly re-enter a known existing destination signing secret in the advanced field. Registration normally manages the secret for you. Send the synthetic test event and refresh until its verified receipt is shown; a queued ping alone is not proof of delivery.
6. In **Optional AI classification**, choose the provider and model, enter credentials, and review the independent enable/automatic-suggestions/automatic-application switches and request limits. Choose a region for Bedrock; OpenAI requires no region. Existing database provider settings and credentials are preserved. For legacy database documents without the new automatic-suggestions field, migration initializes it from the existing enable switch and preserves that master switch. Review the displayed switches before changing them. To enable on-demand only, turn on the master switch and leave automatic suggestions off. Automatic application remains explicit opt-in.
7. Review the separate assistant and notification settings. Their existing encrypted credentials and durable notification records are preserved; classification credentials are never reused for the assistant. Synthetic external tests are optional and may incur provider charges or send a test message as disclosed.
8. Remove obsolete integration variables/secret-file mounts after verifying the saved configuration. Keep deployment secrets, particularly APP_SECRET and the selected PostgreSQL `PG*` connection/TLS settings. A future restart or restore must not depend on the removed integration variables.

Settings saves apply to subsequent operations immediately without restarting the app. A provider call already accepted before a change may still complete. Changing the Redbark key/version requires fresh connection verification. Missing, cleared or unreadable credentials pause credential-dependent operations; they do not erase financial history, queued work or notification settings.

## Restore and encryption

Restore a full PostgreSQL backup into an isolated empty target and supply the matching APP_SECRET separately. A database-only backup cannot decrypt credentials. A changed or absent APP_SECRET never activates environment fallback. Restore the original key or replace affected credentials deliberately; changing the environment key alone is not credential rotation. Use the explicit transactional [offline key rotation procedure](settings-security.md) when rotation is intended.

Validate integration settings before allowing a restored worker external network access: backups can contain pending imports, classification jobs and notification deliveries. Rehearse the restore without contacting real providers and verify record counts, ledger totals, overrides, jobs and settings. See [deployment and backup](deployment.md), [Redbark setup](redbark.md), [classification controls](classification.md) and [notification setup](notifications.md).

## Retained jobs after an account change

Queued jobs retain the credential-account identity that accepted them. Jobs from another API key, and legacy jobs whose account cannot be proven, remain stored and paused rather than being submitted under new credentials. Import Health continues to show the retained jobs. After testing the saved connection, request a fresh backfill for the current account if needed. A version-only change requires a new connection test; it does not change the account identity of existing jobs.
