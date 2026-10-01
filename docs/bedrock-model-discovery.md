# Bedrock model discovery verification

Verified 2026-10-01 against the published `8bffb34b64e6e531b4cc40fa583ae320b50d6a5f` source baseline, using synthetic AWS responses, disposable PostgreSQL 17.11, and headless Chromium. No live AWS account, customer credentials, model invocation, production database or deployed application was accessed.

## Delivered behavior

- Both classification and the separate read-only assistant settings have a shared model dropdown that loads automatically after Save, searchable by model name, provider, ID and destination region.
- Administrators can save Bedrock keys and region with a blank model ID; the save explicitly leaves the incomplete configuration disabled and automatically loads choices. Enabling still requires a model, usable saved credentials, and the assistant's existing data-sharing acknowledgement.
- Regional AWS foundation-model discovery is combined with paginated system/application inference profiles. Exact profile IDs are retained; profiles targeting the same base model remain separate choices.
- Text/on-demand foundation models are shown; known non-text/provisioned-only base choices are filtered. ACTIVE choices sort first; LEGACY and unknown lifecycle states remain visible. Unknown source-region profile metadata stays explicitly unverified.
- No selection is made automatically. Existing/custom IDs remain editable and preserved, including when a list is empty, incomplete or denied.
- Listing is explicitly distinguished from account access and Converse/system-prompt/tool compatibility. Existing read-only pre-inference availability checks are unchanged.

## Security and bounded work

The administrator-only POST routes use the existing exact-Origin check, demo restriction, no-store responses and a shared five-requests-per-minute limiter. Bodies accept only the saved revision. Credentials are decrypted from the existing encrypted database namespace on the server, never accepted by discovery from a browser body, and never returned. Classification and assistant credentials remain independent.

A revision derived from the stored settings, update timestamp and ciphertext is checked before and after each discovery, including failures. Key clear/rotation, region/provider changes and same-value saves invalidate pending work. The shared React picker adds request cancellation and identity fences for edits, repeated clicks, saves, refreshes, provider/region changes and unmounting. Browser storage guards continue to prohibit application persistence in localStorage, sessionStorage, IndexedDB, Cache Storage and service workers.

Only `ListFoundationModels` and `ListInferenceProfiles` are called. Discovery does not invoke a model, create a profile/agreement, submit a use-case form, accept terms, subscribe to Marketplace or send household information. There are no SDK retries or ambient credential/endpoint fallbacks. Work is bounded by a 15-second total deadline, 1 MiB per raw response before SDK JSON decoding, ten profile pages, 100 profiles per request and 1,000 output choices. Repeated tokens stop traversal; partial responses are labeled. SDK messages and metadata are replaced with fixed, actionable diagnostics.

Minimal discovery permissions and operational instructions are in [providers.md](providers.md#bedrock-model-discovery). Runtime invocation/availability permissions remain separate.

## Automated coverage

The new tests cover:

- Credential-first validation, strict activation and unchanged OpenAI requirements
- Text/inference-type filtering, legacy/unknown lifecycle, exact system/application profile selection and profiles absent from the source-region catalogue
- Both permitted lists, partial IAM denial, sanitized failures, page/count/token limits, cancellation and no inference side effects
- The real AWS SDK serializer/deserializer path with a fully intercepted transport: explicit saved signing credentials, official regional hostname, bounded response bytes and client cleanup
- Real PostgreSQL and HTTP with genuine database-backed administrator/member sessions: authorization, exact Origin, strict body, demo blocking, no-store responses, encrypted-at-rest keys, isolated credential namespaces, absent/cleared/undecryptable keys, stale settings and rotation races, and the shared rate limit
- Browser flows for both settings: blank-model saving, search, selection/manual fallback, missing credentials/permissions, partial/empty lists, legacy/custom preservation, repeated clicks, edits/region/provider/save/refresh/unmount races and mobile layout

Final verification results:

- `npm run check`: **229 tests passed, zero failures and zero skips**, plus repository-wide ESLint, exact Prettier checks and the production Vite build
- Both explicitly opted-in PostgreSQL shutdown/recovery tests ran on fresh test-owned clusters
- All ten browser commands passed, including the expanded `test:browser:settings-mocked` suite and the real PostgreSQL/HTTP Settings and SimpleFIN suites
- `npm run check:theme`: passed
- Backup/restore rehearsal: exact rows across all **37 tables** and matching financial reports
- Desktop/mobile classification and assistant pickers visually inspected; no horizontal clipping, secret values or browser-storage violations

All provider transports in development verification are synthetic. A successful catalog request is not evidence that a selected real AWS model can be invoked. A Docker image build, production deployment and real AWS/IAM/model validation were not performed.

## Independent review

An independent security review found no blocking backend issue and separately exercised the SDK response-size guard and revision fencing. Its one comment correction, clarifying that provisioned/custom resources remain unsupported by the existing runtime availability guard, was applied. No migrations, encrypted credential formats, financial accounting logic, region catalogue or provider inference behavior were changed.

## Credentials-first save regression correction

The first published picker still made the manual ID field browser-required whenever Enable was checked. That allowed an administrator to reach a circular setup state: credentials could not be saved because the model was missing, while the model list needed saved credentials. The separate disabled **Load models** button made the setup path unclear.

The corrected flow uses the ordinary **Save provider settings** or **Save assistant settings** button. A model is never required for a Bedrock credential save. An incomplete configuration is explicitly saved disabled, with that consequence shown before and after saving. The primary dropdown is always visible, and each successful Bedrock save automatically loads it using the returned public revision. There is no separate Load models control. Manual ID entry is an optional disclosure; **Retry loading models** appears only after failure and preserves the saved keys. Selecting a model does not enable inference, and clearing a model clears the draft enable switch.

Save responses are fenced against edits/provider changes/unmounting before they update the form or launch discovery. The automatic request starts only after the form commits the exact successful save response, cleared secrets and matching draft, preventing that commit from cancelling its own discovery request. Existing in-flight discovery fences remain in force.

Regression coverage exercises ordinary Save without any model ID for both settings, automatic list population, disabled-before-selection/explicit enabling, clearing an enabled model, saved-credentials retention after discovery failure, retries, stale save/discovery responses, manual fallback and no inference. The real HTTP/PostgreSQL browser suite injects both Bedrock list operations at the SDK boundary so automatic discovery never reaches live AWS.
