# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest release receives fixes.

## Reporting a vulnerability

Report a suspected vulnerability privately: open the repository's **Security** tab on GitHub and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for it.

Include the affected version or commit, the steps to reproduce and the impact you observed. Use synthetic data only. Never include real financial records, credentials, session tokens or an `APP_SECRET`.

## Scope

In scope: the code in this repository, including the Docker image and Compose files it ships.

Out of scope: installations you do not operate, and the external services dolphino connects to (Redbark, PocketSmith, SimpleFIN, OpenAI, Amazon Bedrock, Telegram and SMTP providers). Report problems in those services to their operators.

The [security model](docs/security-assessment.md) describes the threat model, the role boundaries and the known residual risks.
