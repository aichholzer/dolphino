# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest release receives fixes.

## Reporting a vulnerability

Report a suspected vulnerability privately: open the repository's **Security** tab on GitHub and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for it.

Include the affected version or commit, the steps to reproduce and the impact you observed. Use synthetic data only. Never include real financial records, credentials, session tokens or an `APP_SECRET`.

## Scope

In scope: the code in this repository, including the Docker image and Compose files it ships.

Out of scope: installations you do not operate, and the external services Dolphino connects to (Redbark, PocketSmith, SimpleFIN, OpenAI, Amazon Bedrock, Telegram and SMTP providers). Report problems in those services to their operators.

## How Dolphino protects your data

- Passwords are hashed with scrypt and a per-user salt. Sessions last twelve hours, and only a hash of each session token is stored.
- Saved credentials are encrypted with AES-256-GCM under a key derived from `APP_SECRET`. The API never returns them.
- Administrators see everything. Members see only the accounts and budgets they are granted, and every request is checked against the current grants.
- Requests that change data must come from the exact `APP_ORIGIN`.
- Nothing leaves the installation unless an administrator enables it: bank feeds, notifications and AI features are all off by default.
