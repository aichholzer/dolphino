# Read-only finance tool boundary

The assistant calls `invokeFinanceTool(name, args, { getFinance, now, timeZone })`.
`getFinance` is supplied by the authenticated server and produces its current authorized
finance facade. No model-supplied actor, role, grant, SQL, arbitrary URL, code, database
credential or raw provider evidence is accepted. Unknown tools and unknown argument
keys fail closed. The module has no database client or network API.

The strict tool catalogue includes permitted account snapshots, transaction search and
detail, authorized category-name/key lookup, deterministic date-range resolution,
exact grouped/ranked/period-comparison calculations, separate budget totals,
coverage metadata, and downloadable-report queries. Account permissions restrict the
ledger before calculations; budget permissions independently authorize that budget's
whole-household category totals without merchant details or underlying transaction IDs.
Transfer redaction and membership authorization remain owned by the shared facade.

Dates are inclusive, default to the previous 90 calendar days including today in the
configured timezone, and cannot exceed 366 days per selection. Currency is mandatory.
Financial selections may instead supply `dateRange` with `period`, nullable `count`,
and nullable `from`/`to`, leaving outer `from`/`to` null. The same resolver powers
`finance_dates`: today/yesterday, this/last Monday–Sunday week, this/last calendar month,
rolling `last_n_days`/`last_n_weeks` through today, `previous_n_months` for complete months,
or `custom` inclusive dates. Relative calculations use one question-scoped server clock
and configured IANA timezone; model-supplied timezone/location overrides are rejected.
Results include local today and explicit local-date filters plus DST-aware UTC
start-inclusive/end-exclusive bounds. UTC bounds describe timestamps; ledger labels
remain local dates. Source downloads use pinned absolute dates, not recalculated relative periods.
An optional previous-period comparison uses the immediately preceding equal-length
period. Transactions page at 100 rows maximum. Calculations first check the permitted
selection count, then use the facade's atomic export snapshot, never a displayed page.
Selections above 10,000 transactions fail rather than producing incomplete totals.
All output is capped at 64 KiB; excess output returns an explicit narrowing error.
Grouping rankings may display fewer groups; totals remain complete and truncation is
explicit. A split transaction can contribute to multiple group counts, so group counts
must not be summed as a count of distinct purchases.

Money stays integer minor-unit strings and calculations use the existing ledger engine.
Posted transactions determine income/spending; pending amounts are separate, transfers
and card repayments are excluded, and posted refunds reduce spending. A category filter
on aggregate tools counts only the matching split amounts. Transaction searches return
the whole matching transaction. Signed amount filters apply to original transaction
amounts before split projection. Merchant grouping uses the existing description field;
it is not a separately verified merchant entity.

Financial results carry resolved filters, currency, timezone, generation time, permitted
account coverage/freshness and truncation. Source balances remain independent snapshots,
not evidence that a ledger reconciles. No complete-history or live-bank-freshness claim
is made. The report tool returns a validated query, not broader permissions: downloading
must resolve the current session/grants again and recompute it. A grant revocation must
never leave a previously saved report query able to read its former scope.

`finance_dates` contains only authorized server calendar context; it reads no account
data and does not require a currency. Category lookup returns only the authorized
catalog vocabulary and archived labels. Unknown/ambiguous category queries return
structured clarification errors, never a zero total. Financial queries resolve a
unique display name/synonym to its stable key before selection and split projection.
