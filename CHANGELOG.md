# Changelog

All notable changes to dolphino are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com).

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
