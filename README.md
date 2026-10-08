![Altiplano](https://raw.githubusercontent.com/aichholzer/altiplano/a045975ddd6b59f7c690fa5507a4f55a893c5ab8/banner.png)

# Dolphino

A self-hosted personal finance app for your household. Bank feeds bring your transactions in, rules and an optional AI sort them into categories, and budgets, alerts and a read-only assistant show you where the money goes.

## Features

- An overview of income, spending and cash flow, with category charts and account balances.
- Bank feeds from Redbark, PocketSmith and SimpleFIN, plus manual accounts with transfers and balance adjustments.
- Search across your whole history, with corrections, splits, tags and a review queue for anything uncertain.
- Rules that categorise and tag transactions as they arrive.
- Monthly budgets with rollover and overspend alerts, in the app, by email or on Telegram.
- Optional AI, through OpenAI or Amazon Bedrock: category suggestions for new transactions, and an assistant that answers questions about your finances.
- Household members with their own sign-in and access to the accounts and budgets you choose.
- Encrypted credentials, JSON export, and backup and restore scripts.

Every amount is an exact integer in minor units. Totals never drift by a cent.

## Try the demo

You need Node.js 24 or later and a PostgreSQL database you can dedicate to the demo. Copy `.env.example` to `.env` and set `PGHOST`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`, then:

```sh
npm ci
npm run build
node --env-file=.env backend/src/utils/seed.mjs
node --env-file=.env backend/src/server.mjs
```

Open <http://localhost:3001>. The demo runs on fictional data and connects to no bank or provider.

## Run it for your household

Set `DOLPHINO_MODE=live`, an HTTPS `APP_ORIGIN` and an `APP_SECRET`, then follow the [deployment guide](docs/deployment.md) for Docker Compose, PostgreSQL and backups. [Household sign-in](docs/household-auth.md) covers the first administrator and inviting members. Bank feeds, notifications and AI features are set up in **Settings**. Their credentials are stored encrypted in PostgreSQL.

## Documentation

- **Bank feeds:** [Redbark](docs/redbark.md), [PocketSmith](docs/pocketsmith.md), [SimpleFIN](docs/simplefin.md), [import health](docs/import-health.md)
- **Using dolphino:** [manual accounts](docs/manual-accounts.md), [categories, tags and search](docs/categories-tags.md), [classification](docs/classification.md), [assistant](docs/assistant.md), [notifications](docs/notifications.md)
- **AI setup:** [shared AI settings](docs/ai-settings.md), [providers](docs/providers.md), [assistant data sharing](docs/assistant-settings.md)
- **Running it:** [deployment](docs/deployment.md), [reverse proxies](docs/reverse-proxy.md), [encrypted settings](docs/settings-security.md), [upgrading](docs/upgrading.md), [security model](docs/security-assessment.md)

## Development

For frontend work, set `APP_ORIGIN=http://localhost:5173`, start the backend as above, run `npm run dev --workspace frontend` in a second terminal and open the app on port 5173.

```sh
npm run check
```

That runs lint, the format check, the build and the tests. Tests that need PostgreSQL skip until you point them at a disposable database. [Testing](docs/testing.md) explains how to set one up, run the browser checks and measure coverage. [Architecture](docs/architecture.md) covers the code layout and conventions.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

dolphino is released under the [MIT License](LICENSE.md).
