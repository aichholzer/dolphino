![Dolphino](https://raw.githubusercontent.com/aichholzer/dolphino/refs/heads/main/assets/Banner.png)

# Dolphino

[![CI](https://github.com/aichholzer/dolphino/actions/workflows/ci.yml/badge.svg)](https://github.com/aichholzer/dolphino/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/aichholzer/dolphino)](LICENSE.md)

A clean and simple, self-hosted finance app for your household.<br />

## Features

- An overview of income, spending and cash flow, with category charts and account balances.
- Supports bank data feeds from Redbark, PocketSmith and SimpleFIN, plus manual accounts with transfers and balance adjustments.
- Support for multiple currencies.
- Search across your whole history, with corrections, splits, tags and a review queue for anything uncertain.
- Rules that categorise and tag transactions as they arrive.
- Monthly budgets with rollover and overspend alerts, in the app, by email or on Telegram.
- Optional AI, through OpenAI or Amazon Bedrock: category suggestions for new transactions, and an assistant that answers questions about your finances.
- Household members with their own sign-in and access to the accounts and budgets you choose.
- Backend powered by [Rayo](https://github.com/GetRayo/rayo.js).

> Amounts are exact integers in minor units. Totals never drift. Not by one cent.

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

Follow the [deployment guide](docs/deployment.md): Docker Compose, PostgreSQL, HTTPS, the first administrator and backups. Bank feeds, notifications and AI features are then set up in **Settings**, and their credentials are stored encrypted in PostgreSQL.

## Documentation

- [Deployment](docs/deployment.md): install, configuration, reverse proxy, backups and upgrades
- [Bank feeds](docs/bank-feeds.md): Redbark, PocketSmith and SimpleFIN
- [Notifications](docs/notifications.md): email and Telegram alerts
- [AI features](docs/ai.md): category suggestions and the assistant
- [Development](docs/development.md): code layout, tests, coverage and CI

## Development

For frontend work, set `APP_ORIGIN=http://localhost:5173`, start the backend as above, run `npm run dev --workspace frontend` in a second terminal and open the app on port 5173.

```sh
npm run check
```

That runs lint, the format check, the build and the tests. Tests that need PostgreSQL skip until you point them at a disposable database. [Development](docs/development.md) explains how to set one up, run the browser checks and measure coverage.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

Dolphino is released under the [MIT License](LICENSE.md).
