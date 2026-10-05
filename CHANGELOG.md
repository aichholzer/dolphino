# Changelog

All notable changes to dolphino are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com).

## 0.1.2 - 2026-10-05

### Fixed

- A tag typed into a transaction, manual entry or rule editor counts as an unsaved change from the first keystroke. Pressing Back straight after typing asks before discarding it.

## 0.1.1 - 2026-10-04

### Fixed

- The Settings navigation browser check waits for the administrator's AI section to finish loading, then counts only requests made by the reloaded member page. Late reads from the administrator page had made the member access assertion fail intermittently.
