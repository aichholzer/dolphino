# Read-only household assistant

Open the Assistant button to use the right-hand panel. An administrator must first configure its separate provider/model and encrypted credentials in Settings, acknowledge financial-data sharing, and enable it. Classification settings are independent. Each user must acknowledge the disclosure before sending a question. Unconfigured service shows a setup message, never simulated answers.

The assistant receives no database connection, credentials, SQL executor, arbitrary URL fetcher, or mutation tools. Server-owned read services apply the signed-in user's current grants before retrieving or calculating anything. Administrators have full financial access; members have only explicit account grants and separately granted budget totals. Budget access does not expose underlying transactions. The assistant cannot change finances, settings, membership, send notifications, or browse the web.

## Tools and supporting evidence

| Tool | Authorized coverage |
| --- | --- |
| `finance_accounts` | Account details, source balance snapshots and freshness |
| `finance_transactions` | Date/account/category/merchant/amount/status/kind search and bounded pagination |
| `finance_transaction` | One transaction, splits and local correction within account permission |
| `finance_aggregate` | Exact income/expenses/net and pending/transfer amounts, grouped by month/category/merchant/account; rankings and prior equal-period comparisons |
| `finance_budgets` | Granted monthly budgets, allocations, rollover and overspend alerts; no underlying account disclosure |
| `finance_quality` | Permitted account import coverage and reconciliation limitations |
| `finance_report` | Downloadable exact aggregate report, regenerated under current permissions |

Amounts and comparisons are computed by backend integer arithmetic, not by asking the model to add displayed rows. Currency is required; currencies are never converted or combined. Report downloads are authenticated JSON, not public links. Tool provenance includes filters, timezone, currency, generation time, coverage and truncation. Inspect supporting evidence: natural-language model output can still be mistaken. See [tool contracts and financial policy](assistant-tools.md).

## Privacy, limits and operations

Chats are private to their owner, including against other administrators through the app. They are held only in this server process for 30 minutes and disappear on restart; ten turns per chat and ten chats per user. Permission revisions invalidate old context even when the same grants are later restored. Provider configuration changes require a new conversation. Do not run multiple app replicas without sticky sessions; conversation persistence is deliberately outside this MVP.

Retrieved authorized financial data and the user's question are sent to the chosen provider. OpenAI uses Responses with `store:false`, which is not a zero-retention guarantee. Bedrock retention depends on the model/region and AWS logging configuration. No silent provider fallback is used. See [provider contracts and privacy](providers.md).

Administrator controls cap provider requests per user/day (default 10, UTC reset), tools, rounds and output tokens. The durable quota counts provider attempts, including failures. Hard ceilings are four rounds, eight tools, a 60-second turn, 128 KiB model context and 64 KiB responses/results. Selections cover at most 366 days and 10,000 matching transactions; excess fails with a narrowing request rather than incomplete totals. These are request/size limits, not a guaranteed currency-denominated cost cap; set provider billing limits too.

Stop aborts subsequent work and requests cancellation from the provider best-effort; it cannot guarantee no inference cost. Responses are delivered as a complete reply with a busy state, not token streaming. Provider errors stop the turn without automatic retries. Model compatibility requires the administrator's explicit synthetic tool-use test; it may incur a small inference charge. Basic credential tests do not invoke a model. Bedrock access must already be authorized; Profe does not subscribe to models or accept terms.

No live provider calls were made during development. Provider contracts, permission changes, forged tools, report ownership, cancellation and UI flows are covered with mocks and fictional data.
