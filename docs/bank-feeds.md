# Bank feeds

Dolphino imports accounts, balances and transactions from Redbark, PocketSmith or SimpleFIN. All three are read-only and set up by an administrator in **Settings → Bank feeds**. Credentials are encrypted with `APP_SECRET` before they are stored, and saving them takes effect without a restart.

Connect each bank through one source only. The same bank imported through two sources shows up twice.

## Redbark

1. Create a Redbark API key with `data:read`. Add `categories:read` to see Redbark's category names; without it, imports still work and those transactions show as Uncategorized.
2. Enter the key, the API version (default `2026-10-01.wattle`) and how many days of history to keep in sync (default 90, up to 2555). Save, then select **Test connection**. Imports start once the test passes.
3. Dolphino checks for new data every four hours. For faster updates, register an event destination: enter your public HTTPS origin and select **Register**. This needs `events:write` and permission to list destinations on the key. Redbark must reach `/api/webhooks/redbark` without signing in. Behind Cloudflare Access, add an exception for that path only. To keep a destination you created yourself, enter its signing secret in **Redbark signing secret**.

Set the time zone of your Redbark accounts to match `DOLPHINO_TIMEZONE`. Redbark sends calendar dates, and Dolphino uses them as given.

Transactions imported before category names were available can show codes such as `cat_…`. Use **Repair category names** in **Settings → Data** to replace them without downloading history again.

## PocketSmith

1. Create a developer key in PocketSmith under **Settings → Security**, and save it in the PocketSmith panel.
2. Select **Test and discover accounts**, choose the accounts to import and set how many days of history to fetch (1 to 2555).
3. Enable imports and save. History is fetched in 30-day windows, then each account is checked every four hours.

Dolphino only reads from PocketSmith. A developer key is meant for your own account; to run Dolphino for other PocketSmith users, PocketSmith requires a registered OAuth app.

## SimpleFIN

1. Create a setup token with your SimpleFIN provider, paste it into the SimpleFIN panel and select **Connect SimpleFIN**. The token can be claimed once; the access URL it returns is stored encrypted and never shown again.
2. Select **Test and discover accounts**, then **Map as a new account** for each account you want.
3. Select **Enable scheduled imports** and save. Accounts are checked every four hours.

Only posted transactions are imported. The provider must serve HTTPS from a public hostname. **Disconnect locally** stops imports and keeps your history; revoke the connection with your provider as well.

## History and import health

**Settings → Data** shows each feed's status, when accounts last updated, the period the latest import covered and recent import jobs. Failed jobs retry automatically, honouring the provider's rate limits.

To fetch older history for a Redbark account, choose the account and a start and end date, up to 2555 days and not in the future. PocketSmith and SimpleFIN accounts have the same option in their own panels.
