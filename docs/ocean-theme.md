# Ocean visual system

The original dolphin vector outline, fins, tail, eye and belly detail are preserved. Only its two fills changed to ocean blue and sea glass; the monochrome mark is unchanged. No remote fonts, imagery or runtime dependencies were added.

## Palette and hierarchy

- White full-document-height sidebar with a quiet pale-blue selected state; deep ocean primary actions: `#123e50`
- Primary navy text: `#173847`; secondary text: `#395b68`; muted text: `#526c76`
- Soft neutral canvas: `#f7f9f8`; white cards with fine blue-green borders
- Sea-glass income/success icon accents: `#e5f2eb`; dark green semantic text: `#246d58`
- Pale coral spending icon accents: `#fff0e9`; deep coral semantic text: `#a54d38`
- Light blue net-cash-flow and informational accents: `#edf5f7`
- Soft sunshine warning surfaces: `#fff6d9`; dark ochre warning text: `#805d19`
- Six distinct ocean/sea/coral/sky/sun/tide category-chart tokens

Two Google Fonts families ship with the app through Fontsource packages and are served from its own origin. Faustina, a variable serif, sets page, sign-in and assistant headings (`--font-display`). Hanken Grotesk, a variable grotesque with tabular figures, sets controls, data and the wordmark (`--font-ui`). Vite never inlines a font file; the CSP refuses `data:` fonts. Monetary figures keep tabular numerals. Small helper text was increased and darkened. Metric and support cards remain white; restrained pastel border and icon accents and chart fills carry the ocean palette without large colored panels. The sidebar stretches to match the full document, with a sticky inner navigation on desktop and a viewport-height drawer on mobile. Financial meaning is also provided by labels, amounts, signs, icons and refund patterns.

The same tokens cover transactions, accounts, budgets, review, rules, settings, authentication, assistant conversations, dialogs, empty/loading/error states, hover, focus and disabled controls. The mobile month comparison retains its original scrollable table and adds a visible scroll hint, keyboard-focusable labelled region and focus outline.

## Checks

- `node scripts/check-theme.mjs`: verifies token resolution, absence of the prior purple theme, original SVG geometry, exact published/source SVG equality, WCAG AA normal-text contrast pairs and 3:1 focus contrast
- Text contrast checks: primary at least 11.52:1; secondary 7.32:1; muted on canvas at least 5.18:1; muted on sea glass 4.84:1; navigation at least 5:1; semantic text pairs at least 5.08:1
- `node scripts/browser-theme.mjs`: exercises the real fictional-demo application at 1440px, 390px and 320px; captures all seven screens, assistant unavailable/disabled state, API loading/error/retry, empty period, and synthetic login/initial setup. Verifies no page errors or viewport overflow, full-document sidebar height and sticky navigation on the long Settings page, assistant dismissal/focus restoration, and mobile table keyboard scrolling
- `node scripts/browser-assistant.mjs`: separately exercises and captures fictional mocked assistant conversations, report sources, cancellation, focus trapping and Escape
- `node scripts/browser-brand.mjs`: verifies the SVG at 16, 24, 48, 96 and 160 pixels and the unchanged monochrome version

Screenshot fixtures and credentials are fictional. Browser checks honour `CHROMIUM_PATH`; see [testing](testing.md).
