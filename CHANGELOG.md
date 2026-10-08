# Changelog

All notable changes to dolphino are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com).

## 0.2.24 - 2026-10-08

### Removed

- `scripts/backup.sh` and `scripts/restore.sh`, with the restore rehearsal and their tests. Back up with `pg_dump` and restore with `pg_restore`, as the deployment guide shows.

### Changed

- The key rotation script is `scripts/rotate-secrets.mjs`. `scripts/recover-user.mjs` explains at the top what it is for and who should be able to run it.
- The documentation is five short guides: deployment, bank feeds, notifications, AI features and development. Notes on how and why features were built are gone, and `SECURITY.md` summarises how data is protected.

## 0.2.23 - 2026-10-08

### Added

- A coverage floor. `npm run coverage:check` fails below 90% of lines, statements and functions, or 88% of branches, across the combined unit and browser report. CI runs it after the browser checks. The report stood at 94.4%, 94.4%, 92.3% and 90.1% when it was set.

## 0.2.22 - 2026-10-08

### Added

- A browser check for Settings > Members against the real backend: invitations with account and budget access, a duplicate refused, resend and revoke, saving grants, granting and revoking administrator, disabling and enabling, password reset emails, and the unsaved-draft guard.
- The manual accounts check covers split rows and the refusal to purge an account still linked by a transfer to an active one.

## 0.2.21 - 2026-10-08

### Fixed

- Browser coverage keeps every page load. Chromium drops a document's coverage when the page loads another one, and `frontend/test/browser.mjs` now saves it before each `goto`, `reload`, `goBack`, `goForward` and `setContent`. Checks that reloaded had reported only their last page: the combined report moves from 90.3% to 94.0% of lines, and the Members screen from 3% to 88%.

## 0.2.20 - 2026-10-08

### Fixed

- Notification delivery runs on the database clock. The audience confirmation and the email and Telegram enable times are stamped by PostgreSQL, and the Telegram limit of one message per chat every 3.1 seconds is measured there. They were stamped by the app and compared with event times from the database. With the app clock ahead, an alert raised just after enabling was cancelled; behind, one raised just before confirmation could be sent, and the Telegram limit drifted. This was the cause of the intermittent outbox test failure.

## 0.2.19 - 2026-10-08

### Fixed

- `npm run check` and CI build the frontend before the tests. The security test reads the headers of the built `index.html` and failed with 503 on a fresh clone.
- The database connection-loss tests attach their rejection checks before killing the connection. A fast kill rejected the query first, and Node reported the rejection as unhandled.

## 0.2.18 - 2026-10-07

### Added

- GitHub Actions CI on every push to `main` and every pull request: lint, the format check, the unit suite and every browser check under coverage against PostgreSQL 17, and the production build. The coverage summary goes to the job summary and the HTML report to the `coverage` artifact. Actions are pinned to commit SHAs and the workflow token is read-only.

## 0.2.17 - 2026-10-07

### Added

- `npm run coverage` and `npm run coverage:browser` measure coverage with c8 across the unit suite and every browser check, including the servers and scripts those start. Chromium coverage maps back to `frontend/src` through a coverage build, `vite build --mode coverage`. The report lists every file in `backend/src`, `frontend/src` and `scripts`, loaded or not. `c8` is a new development dependency.
- `npm run test:browser:all` runs every browser check in turn, with a freshly seeded demo on its own schema for the checks that need one.

### Changed

- Tailwind reads only `frontend/index.html` and `frontend/src`. Tests, docs and build settings no longer add utilities to the production CSS, and five unused ones are gone.
- Browser checks launch Chromium through `frontend/test/browser.mjs`.
- The Docker build context leaves out `coverage/` and `artifacts/`.

### Fixed

- The enhancements browser check waits for the three-month dashboard request. It raced the request and failed against a slower bundle.

## 0.2.16 - 2026-10-07

### Added

- Tests that start `backend/src/server.mjs` in demo and live mode against PostgreSQL: health, session, HSTS, the first-administrator bootstrap, refusal of a database bound to the other mode, invalid settings, and clean exit on SIGTERM and SIGINT.
- End-to-end tests for `scripts/recover-user.mjs` and `scripts/rotate-settings-key.mjs`: a single-use reset link for an active user only, generic errors otherwise, and key rotation that re-encrypts every credential, refuses a weak or wrong key, and prints no secret.

## 0.2.15 - 2026-10-07

### Added

- Tests for the seven React hooks and the date and label helpers. The hooks render in Node against jsdom through `frontend/test/react-harness.mjs`, which compiles `.jsx` imports with esbuild and fails a test file on any React or jsdom console error. `jsdom` and `esbuild` are new development dependencies.

### Fixed

- A calendar day that does not exist, such as 2026-02-30, is shown as given. It was rolled over and shown as 2 Mar 2026.

## 0.2.14 - 2026-10-07

### Added

- HTTP tests for every user-management action: listing, grant options, invitations, resend, revoke, role and access changes, disabling and password resets. They cover sign-in and administrator checks, the Origin check, strict request bodies, the demo-mode refusal and the per-action limit of five a minute, plus the single-use links in the mailed invitations and resets.

## 0.2.13 - 2026-10-07

### Changed

- The browser checks, the theme check and the restore rehearsal moved from `scripts/` to `frontend/test/` and `backend/test/`. `scripts/` holds only the operator tools, and the Docker image no longer ships test code. The npm script names are unchanged.
- The README is shorter: what dolphino does, how to try and run it, and where the guides are.

## 0.2.12 - 2026-10-07

### Removed

- The `artifacts/` folder of screenshots and logo copies. Browser checks still write their screenshots there, and Git ignores it. The logo lives in `frontend/public/`.

## 0.2.11 - 2026-10-07

### Added

- dolphino is released under the MIT licence (`LICENSE.md`). `SECURITY.md` describes how to report a vulnerability privately.
- `docs/testing.md` covers the test database, the checks, the browser suites, the database outage tests and the restore rehearsal.

### Changed

- `docs/security-assessment.md` is the security model: threat model, role matrix, fixed findings, attack cases with their tests, and residual risk.

### Removed

- Dated verification records and review logs from `docs/`. The topic guides keep how to run each test suite.

## 0.2.10 - 2026-10-07

### Added

- "Also suggest categories for older transactions" in AI classification, off by default. It sends unresolved transactions dated before the classification start date, including backfilled history. Settings shows how many there are; each is one provider call. Turning it off again leaves queued older jobs waiting.

### Changed

- Automatic category suggestions cover only transactions dated from the day classification and automatic suggestions were first turned on, in the household time zone. Settings shows that date. Settings saved before this release use the day they were last saved. On-demand suggestions work for any date.
- The automatic scan reads merchant rules once per scan.

### Removed

- The classification settings "Requests per UTC day" and "Maximum import batch". There is no daily request limit; the worker sends five automatic suggestions every 30 seconds, one at a time.

## 0.2.9 - 2026-10-07

### Changed

- An assistant conversation accepts 25 questions before asking for a new one, up from ten.

## 0.2.8 - 2026-10-07

### Removed

- The data-sharing disclosure and checkbox in the assistant chat pane. The administrator acknowledges data sharing in Settings when enabling the assistant. `POST /api/assistant/chats/:id/messages` takes `{ message }` only and rejects `acknowledgeDataSharing`.

## 0.2.7 - 2026-10-07

### Changed

- An assistant answer may take up to eight model rounds and 24 tool calls; the last round asks the model to answer from the results it already has. A provider call may take 60 seconds and a whole answer three minutes, up from 15 and 60 seconds.

### Removed

- The assistant settings for daily requests per user, tool calls per answer, model rounds per answer and maximum output tokens. There is no daily request allowance, and answers use the model's own maximum length. Settings saved by earlier versions still load, and the removed fields disappear on the next save.

## 0.2.6 - 2026-10-07

### Changed

- The Bedrock model dropdowns in AI features group models under a heading for each provider, such as Anthropic, Amazon and Meta. The search fields, the model count, manual model ID entry and the selected-model details are gone. A saved model missing from the loaded list stays selected and reads "not in the loaded list".

## 0.2.5 - 2026-10-06

### Changed

- Interface text is set in Hanken Grotesk, and page, sign-in and assistant headings in Faustina. Both come from Google Fonts and are served by the app itself. Every screen had used the platform font, SF Pro on macOS and Segoe UI on Windows, with Georgia headings.
- Page headings track at -0.6px. Faustina is narrower than Georgia, and the old -1.1px closed the space after a comma.
- The fictional demo screenshots show the new type.

## 0.2.4 - 2026-10-06

### Fixed

- Saving or deleting a rule revisits only the transactions whose description matches the rule's old or new text. With 20,000 imported transactions a save took 82.8 seconds inside one database transaction; it now takes under half a second. The latest provider kind for those rows is read in one query.

## 0.2.3 - 2026-10-05

### Fixed

- The server no longer exits when a database connection drops while a request or background job holds it, for example during a long rule save. node-postgres removes its error listener from a client in use, and the next connection error stopped the process. Every pool client now keeps a listener; the interrupted request fails with an error and the server keeps running.
- A transaction whose connection is lost reports the original error. The failed `ROLLBACK` no longer hides it, and the broken client is discarded.

## 0.2.2 - 2026-10-05

### Fixed

- A Redbark account whose balance or transactions request is refused is skipped and named in the status, and the other accounts keep importing. When every account is refused, the sync fails and retries as before. Rate limits, provider outages and credential failures still stop the whole sync.

## 0.2.1 - 2026-10-05

### Changed

- Redbark errors in Settings and Import health name the request that failed and Redbark's own error code and parameter, for example "provider_http_400 on transactions: parameter_invalid (from)". Messages, request IDs, account IDs and response bodies are still discarded.
- The Redbark guide notes the provider's limit of about seven years of banking history: a 2555-day rolling window was rejected, while 2500 days was accepted.

## 0.2.0 - 2026-10-05

### Added

- Review queue: select items, or all of them, and resolve them in one action. Each item is still resolved and audited on its own; any that fail stay selected and are named with their error.
- Review keyboard flow: ↑ ↓ or J K to move, A to resolve, X or Space to select and Enter for details. Focus moves to the next item after each resolve.
- Possible-replacement reviews offer a picker of pending transactions in the same account and currency, closest amount first, with an exact amount preselected. Linking still needs an explicit Link pending.
- Overview shows how many transactions need review and links to the Review queue.

### Changed

- Cards, menu items, buttons, inputs and notices use 10px squircle corners, and tags use 8px. Cards and menu items have no accent stripes; the selected menu item has a darker fill and a contrasting border.
- One button system across the app: filled for the main action of a page, form or dialog, bordered for every other action, with one size and padding. Every Add action carries a plus icon, and page-level Add buttons sit on the right.
- Checkboxes and select chevrons are styled to match the ocean palette.
- Review items list Type, Category, Reason and Transaction, and one note above the queue explains what accepting does. "Accept current classification" reads "Accept classification".
- Settings sections have no nested cards or repeated titles, use one 16px rhythm, and show expandable details in a tinted panel. All Settings prose is 12px.
- List rows share one padding, budget cards match account cards, and transaction arrows are sea green for money in and coral for money out.
- Page subtitles state what the page holds, such as counts and the last feed update. Helper prose keeps a 75-character measure and no text is smaller than 12px.
- The Overview cash chart has a labelled axis with round steps and a screen-reader table; the category chart groups the remainder as Other.
- Deleting a rule asks for confirmation inline. "Create category" reads "Add category".
- On mobile, the navigation drawer has a close button, closes with Escape and returns focus to the menu button.

### Fixed

- Dates and times read "3 Oct 2026, 04:54 pm" in the household time zone on every screen.
- Transaction rows show the incoming arrow for every positive amount, including refunds and incoming transfers.
- Stored values such as transaction kinds and connection states display as words.
- PocketSmith and SimpleFIN action buttons are spaced. Four PocketSmith buttons had used an undefined button style and rendered unstyled.

## 0.1.4 - 2026-10-05

### Removed

- Removed the access acknowledgement checkbox from SimpleFIN setup. Connect SimpleFIN is available as soon as a setup token is entered. The connect endpoint takes `{ token }` only and rejects the old `acknowledgeAccess` field.

## 0.1.3 - 2026-10-05

### Fixed

- Six browser checks pass again against the current app. Their fixtures answer the PocketSmith, SimpleFIN, category and tag endpoints; category steps pick from the catalog dropdown; expectations follow the Bank feeds route and key-based category values; and the assistant check waits for focus to return after the dialog closes.
- The budget smoke check deletes its synthetic budget from the month it was created in. It had looked in a fixed month and left the budget behind.

## 0.1.2 - 2026-10-05

### Fixed

- A tag typed into a transaction, manual entry or rule editor counts as an unsaved change from the first keystroke. Pressing Back straight after typing asks before discarding it.

## 0.1.1 - 2026-10-04

### Fixed

- The Settings navigation browser check waits for the administrator's AI section to finish loading, then counts only requests made by the reloaded member page. Late reads from the administrator page had made the member access assertion fail intermittently.
