# Shared AI settings

Administrator Settings has five sections: **RedBark**, **Members**, **Notifications**, **Data**, and **AI features**. Data groups SimpleFIN, import health/history and JSON export. AI features contains one OpenAI or Amazon Bedrock connection used by both optional features; credentials are entered once.

## Connection and feature controls

1. Choose OpenAI or Bedrock in the shared connection form. Enter the OpenAI API key, or the Bedrock permanent access key ID, secret access key and supported AWS region. Temporary AWS keys/session tokens are unsupported. A model is not needed to save the connection
2. Save the connection. Secret inputs clear and show only configured/masked status. Omitted or blank secrets retain the saved ciphertext; an explicit `null` clears the selected credential. No plaintext or last characters are returned
3. For Bedrock, one read-only catalog automatically loads from the saved connection when AI features opens, after a connection save, on return, reload and restart. It supplies both searchable model pickers. Blank password fields do not block loading. Retry uses the saved credentials; manual IDs remain available when listing is unavailable or incomplete
4. Select and save each feature's model and limits. Classification has its own enable, automatic-suggestions and automatic-application controls. The assistant has its own enable switch, data-sharing acknowledgement, per-user request allowance, tool/round limits and output-token cap. Neither feature enables the other

Discovery lists regional foundation models and inference profiles; it does not invoke a model, send household data, enable features, verify inference access or accept model terms. OpenAI model IDs remain manual. Connection testing is read-only. Explicit synthetic model tests are separate actions, require cost acknowledgement and can incur a small charge. See [provider contracts and IAM boundaries](providers.md).

A changed shared provider, region or credential **pauses both features**. Switching between OpenAI and Bedrock also clears incompatible model selections and resets the assistant's data-sharing acknowledgement, so the new recipient is reviewed explicitly. Same-provider key/region changes keep models, consent and all feature limits for review before re-enabling. Classification automation preferences are retained, but cannot run while classification is disabled. Unchanged connection saves preserve feature controls but issue a fresh connection revision and reload the catalog; feature-only saves leave that catalog revision unchanged.

## Storage and runtime

PostgreSQL is the only integration settings source. The canonical documents are:

- `ai.provider`: one provider and optional Bedrock region
- `ai.classification`: classification model, enablement, automation and limits
- `ai.assistant`: assistant model, enablement, sharing acknowledgement and limits
- `encrypted_credentials` entries `ai.apiKey`, `ai.accessKeyId` and `ai.secretAccessKey`, bound to their exact setting name and selected provider; only the required provider slots are used

Version 3 authenticated encryption and APP_SECRET requirements are unchanged by this consolidation. The same shared credential decrypts into both runtime projections, but each projection carries its own feature model, controls and revision. There is no credential/model fallback from environment variables or an alternate provider. Missing/wrong APP_SECRET makes required credentials unavailable and both features fail closed; imported finances, authentication, grants and manual work remain usable.

`createAiSettings` reads shared metadata, feature documents and encrypted rows in one PostgreSQL MVCC statement. Mutations use the common advisory transaction lock, including the lock used when committing classifications. Runtime revisions include the shared connection identity and the relevant feature document. A shared or feature change invalidates stale asynchronous work; provider tests and model discovery fence both successful and failed responses. An already accepted external request may still complete or be billed, but a late response does not authorize stale local application or a further provider round.

## Upgrading separate AI profiles

Keep the database, its deployment mode and the current APP_SECRET. Stop all old app/worker processes before starting the new version. Back up PostgreSQL and protect the matching key separately. This migration changes AI settings only; it does not wipe or reseed financial data, authentication, imported evidence, corrections, grants, usage counters or queued jobs.

The older documents `llm` and `assistant.llm` are migration inputs only. Production inference never falls back to them:

- Valid, readable version 3 profiles with compatible provider, region and credentials consolidate automatically. A single usable profile can supply the shared connection; complete credentials from separate incomplete profiles are never assembled together. Each feature's model, controls and limits are retained when compatible
- Conflicting providers, regions or credential values require an administrator to explicitly select a readable existing profile or enter a complete replacement credential set. Both features remain paused. No preference is silently chosen between conflicting profiles
- Unreadable or retired version 1/2 envelopes are **never decoded**, including when the original APP_SECRET is restored. Re-enter credentials, explicitly select another readable profile, or deliberately clear all required fields. A blank save does not resolve the conflict
- While a conflict or unreadable profile is unresolved, its old metadata and encrypted rows stay untouched. A failed save, stale revision or unavailable profile selection cannot partially migrate them
- On successful resolution, one transaction writes the canonical shared credentials and feature documents and removes the superseded AI secrets/metadata. Explicit resolution pauses both features. A provider change clears that feature's incompatible model; changing the assistant provider also resets its sharing acknowledgement. Feature limits remain intact

The UI exposes only each candidate profile's provider, region and availability, never its secret values. Selecting a profile must match its recorded provider/region and requires every credential to be readable. Retired formats cannot be repaired by changing APP_SECRET or by the offline rotation command. See [upgrade recovery](upgrading.md) and [encrypted settings](settings-security.md).

## HTTP contract

All settings routes are administrator-only. Writes and external test/discovery actions keep the exact-Origin checks, demo restrictions, sensitive-action limits and no-store responses.

- `GET /api/settings/ai` returns shared provider/region, masked credential state, availability, migration status and a non-secret `discoveryRevision`
- `PUT /api/settings/ai` accepts `revision` from that saved `discoveryRevision`, `provider`, Bedrock `region` when applicable, and only that provider's credential fields. `reuseCredentialsFrom: "classification"` or `"assistant"` explicitly resolves an eligible older profile; it cannot be combined with replacement fields. A stale connection revision returns HTTP 409
- `POST /api/settings/ai/models` accepts only `{ "revision": "<saved discoveryRevision>" }`. Discovery uses saved shared credentials. The retained feature-specific `/models` routes resolve that same shared connection in the production app and share the discovery limiter
- `POST /api/settings/ai/test-connection` tests the saved shared connection without inference. OpenAI uses its model-list endpoint; Bedrock uses STS identity verification, returning no identity/account identifier
- `GET /api/settings/provider` and `GET /api/settings/assistant` retain their public feature metadata, including provider/region/masked availability, and expose `aiRevision` for the current shared connection. The assistant response also retains tools, disclosure and read-only metadata
- `PUT /api/settings/provider` accepts `aiRevision` plus classification-only fields: `model`, `enabled`, `autoClassify`, `autoApply`, `dailyRequestLimit` and `batchSize`
- `PUT /api/settings/assistant` accepts `aiRevision` plus assistant-only fields: `model`, `enabled`, `dataSharingAcknowledged`, `dailyRequestsPerUser`, `maxToolCalls`, `maxRounds` and `maxOutputTokens`

The feature PUT schemas reject provider, region, credential and unknown fields; existing clients must move those changes to the shared route. PUTs should include all intended feature settings because omitted fields use schema defaults. A missing/stale `aiRevision`, unresolved shared migration, unreadable credentials when enabling, or missing model/assistant acknowledgement fails without a partial write. Feature-specific explicit model-test routes remain available and retain their independent cost acknowledgement.

## Backup and verification

Back up the entire PostgreSQL database and keep APP_SECRET separately. The restore rehearsal seeds one shared encrypted credential plus distinct feature configurations, then constructs the actual restored shared service and checks both runtime/public snapshots. It also checks missing/wrong-key fail-closed behavior, quota persistence, exact table rows and financial reports. See [restore evidence](restore-evidence.md) and [shared-settings verification](shared-ai-settings-verification.md).
