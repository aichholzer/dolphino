# dolphino identity and rename audit

The canonical repository was verified through the existing repository API reference: repository ID 1397496608 now reports `aichholzer/dolphino`, with clone URL `https://github.com/aichholzer/dolphino.git`. The existing feature branch is retained for history continuity. No default branch, immutable commit or stored audit record was renamed.

## Original vector artwork

`frontend/public/dolphino.svg` is an original editable dolphin silhouette with a curved belly accent, dorsal fin, beak and forked tail. `dolphino-mono.svg` supplies a one-color alternative with a transparent eye. The assets contain SVG paths/circle, accessible title/description and no embedded raster image, font or external resource. They are used in the sidebar, header, sign-in/setup and favicon. Downloadable source copies are under `artifacts/`; the lowercase wordmark is separate UI text using the existing system font stack.

`npm run test:browser:brand` renders and checks the icon at 16, 24, 48, 96 and 160 pixels plus the monochrome alternative. The desktop/mobile application and login screenshots were visually reviewed. The PNG preview is only a viewing aid; the logo deliverable remains true SVG.

## Case-insensitive old-name scan

The whole tracked text tree was scanned with `git grep -n -i profe`, including source, tests, package/lockfiles, configuration, scripts and documentation. Binary screenshots were regenerated with the new branding. Remaining matches are deliberate and classified below; this is not a claim of zero substring matches.

| Remaining location                                       | Reason retained                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/crypto.js`, `backend/test/settings.test.js` | Historical versioned KDF/AAD protocol domains and legacy-ciphertext fixture. Changing these breaks existing credentials.   |
| `backend/src/config.js`, `scripts/restore.sh`            | Transitional environment aliases with fail-closed conflict detection.                                                      |
| `backend/src/household-auth.js`                          | Legacy session-cookie read and expiration support. New cookies use the new name.                                           |
| `backend/src/store.js`, `backend/src/classification.js`  | Existing advisory-lock namespaces; changing them could defeat coordination with in-flight work.                            |
| `backend/src/users.js`, `backend/src/notifications.js`   | Stable invitation/notification email Message-ID protocol identities for retries. Display subject/body branding is renamed. |
| `backend/test/rename-compatibility.test.js`              | Explicit old-name settings, cookies and encryption vectors used to prove upgrades remain readable.                         |
| `backend/test/compose-upgrade.test.js`                   | Old project, database and volume identities used to prove the rename selects the same storage.                             |
| `docs/rename-upgrade.md`, this report                    | Required upgrade instructions, historical identifiers and the scan command itself.                                         |
| `docs/security-assessment.md`, `docs/verification.md`    | The unrelated ordinary word “professional” contains the search substring; it is not old product branding.                  |

All current product UI, titles, package/workspace names, lockfile entries, export filenames, newly created provider display names, backup filenames, normal environment examples, scripts, fixture display strings, screenshots and repository URLs use lowercase `dolphino`. Existing database/user/volume names are never renamed automatically. Internal compatibility identifiers apply to new installations too where keeping the protocol stable is deliberate. See [upgrade instructions](rename-upgrade.md).
