# Household sign-in and upgrade

Profe uses named household accounts instead of a shared password. The first administrator is established with an explicit installation bootstrap proof; an anonymous visitor cannot claim an uninitialized installation merely by opening the website. Signup closes after that first account. Existing imported transactions, classifications, corrections, budgets and encrypted settings remain in the same PostgreSQL database. APP_SECRET does not change during this upgrade.

## Establish the first administrator

Keep the application bound to loopback or otherwise unavailable to untrusted visitors during first setup. Set live mode and your trusted HTTPS APP_ORIGIN. Generate an independent random bootstrap token in a protected local file, then point `PROFE_BOOTSTRAP_TOKEN_FILE` to its container path. Do not put the token in a URL, command-line argument, repository or chat. Do not reuse APP_SECRET, a provider key or a password.

```sh
mkdir -p secrets
chmod 700 secrets
(umask 077; openssl rand -hex 32 > secrets/bootstrap_token)
```

Set `PROFE_BOOTSTRAP_TOKEN_FILE=/run/secrets/bootstrap_token` in `.env`; Compose already mounts `./secrets` read-only. Ensure the non-root application container can read the file without granting access to other users. Open the restricted HTTPS application, provide the bootstrap token in the setup form, and choose the administrator's email, display name and a unique long password. Once setup succeeds, remove the bootstrap environment setting and remove the token file from the application mount. Restart the app, verify ordinary sign-in, then allow the intended household access. Retaining a bootstrap token does not reopen signup after accounts exist.

## Upgrade from the shared-password MVP

Take a PostgreSQL backup and separately preserve APP_SECRET and deployment configuration. Stop the old app and upgrade the code while maintaining restricted network exposure. Existing legacy shared-password cookies are deliberately invalidated; the old `PROFE_PASSWORD_HASH` is not an administrator identity and cannot claim an account. Establish the first named administrator using the explicit bootstrap procedure above. This creates authentication records alongside the existing ledger rather than resetting or replacing financial data.

Do not regenerate APP_SECRET during this process: doing so would make saved provider credentials unreadable. Removing the obsolete shared-password environment value after successful migration does not alter financial data. Restore tests must restore the matching encryption key separately from the database dump.

## Invitations and access recovery

Administrators invite users with a selected role and explicit grants through the app. Configure and test SMTP with synthetic messages before relying on invitation delivery. Invitations expire after seven days; administrator-requested password reset links expire after one hour. Resending creates a fresh token and revokes the prior link. Tokens are single-use and stored only as SHA-256 hashes. A failed SMTP delivery is visible and requires resend; it does not pretend that the user received the email.

Links use a URL fragment so the token is not part of the HTTP request URL. The browser submits it in the activation/reset request body. Treat the entire link as sensitive; send it only to the intended recipient and avoid pasting it into chat, logs or tickets. No invitations or external emails were sent during development.

If all administrators lose passwords or SMTP is unavailable, a trusted host/database operator can issue a one-hour reset link for an existing active user:

```sh
node --env-file=.env scripts/recover-user.js --email user@example.com
# Container alternative (inherits configured live environment):
docker compose exec app node scripts/recover-user.js --email user@example.com
```

For bundled PostgreSQL, use the same `-f compose.yaml -f compose.postgres.yaml` Compose flags. The command requires live mode, the migrated database and a valid HTTPS APP_ORIGIN. It prints the secret link once to the local operator's terminal; do not capture that output in persistent/shared logs. Open it privately, set a new password, then sign in normally. It neither creates a new account nor bypasses account disablement. No HTTP endpoint exposes this operator capability. Password reset revokes the user's sessions. This development verification did not invoke the recovery command against a real account.

This release has no public self-signup, SSO or MFA. Keep an independently recoverable administrator account and encrypted backups. Database administrators and anyone holding a valid bootstrap proof before first setup are trusted operators. Do not use database row deletion as a password-reset procedure: it can damage auditability and reopen setup assumptions.

## Security boundaries

Password hashes are one-way; provider credentials remain reversibly encrypted with the independent APP_SECRET. Browser sessions are scoped to a named account and must be checked against current database state, so disabling an account can revoke access without changing the encryption key. Cookies are HTTP-only and secure in live mode, with same-site restrictions; mutating API requests require the configured browser origin. Invitations and session bearer values are not stored as plaintext tokens in database rows.

## Explicit financial grants

Administrators have full household financial access and manage users, grants, settings, integrations and global rules. Newly invited members have no financial access until an administrator assigns grants. Account and budget permissions are independent:

| Grant | Allows | Does not grant |
| --- | --- | --- |
| Account view | The selected account, its transactions, permitted history, scoped overview/charts and exports | Other accounts, editing, budget access or settings |
| Account edit | Account view plus local account edits, corrections, splits and permitted review actions | Other accounts, budgets, global rules or settings |
| Budget view | The selected category/currency/month budget row and its full household category spending/remaining/rollover summary | Underlying accounts, transaction drilldowns or editing |
| Budget edit | Budget view plus editing/deleting that existing budget row | Other budgets, accounts, transactions, creating arbitrary new budgets or settings |

A budget grant intentionally reveals the whole-household aggregate for that budget, even when some contributing accounts are hidden. It does not reveal those accounts or their transactions. Overview/chart totals remain scoped to granted accounts and may therefore differ from explicitly granted budget totals. Budget grants address specific month rows; a future month's new row is not automatically granted. Edit includes view. On-demand remote AI classification remains administrator-only because the classifier uses the household category vocabulary; members can manually correct transactions they may edit. Revoked grants are checked by subsequent API requests rather than trusting stale frontend state. Hidden resources return a non-disclosing not-found response.

Internal transfers retain transfer semantics in scoped calculations. Restricted-member transaction responses redact transfer descriptions and notes; transfer counterparty information must not reveal a hidden account. External financial notifications have a separate audience: administrators must explicitly acknowledge that configured email/Telegram recipients receive household category totals independently of app grants. Existing channels remain gated until that confirmation; inviting a user never adds an external recipient.

## Passwords, sessions and limits

Passwords contain 12–128 characters and use asynchronous Node.js scrypt with independent random salts (`N=131072`, `r=8`, `p=1`, 64-byte derived hashes). Two concurrent derivations are allowed per process; excess work returns a retryable busy response. See [Node.js crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) for the primitive. This is separate from reversible encryption of provider secrets.

Sessions expire after twelve hours. A random 32-byte browser token is represented only by its SHA-256 hash in PostgreSQL. Password changes revoke all sessions for that user; role/disable changes revoke affected sessions. Authentication attempts have a durable per-action, per-network-source limit; forwarded IP headers are not trusted, so clients behind one reverse proxy share its source limit. This trades fine-grained attribution for resistance to forged forwarding headers. There is no silent migration of legacy shared sessions or shared password hashes.
