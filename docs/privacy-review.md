# Phase 6 Privacy Review

Status: reviewed for the current prototype.

## Stored Locally

- User-selected automation settings and checklist state.
- Current stats snapshot and bounded six-month history.
- Run state, task outcomes, sanitized errors, and bounded diagnostics.
- Sanitized phase-0 route and selector observations.
- Optional AliExpress account name and password, encrypted with AES-256-GCM in local extension storage and never included in sync settings. The decryption key is stored in the same Chrome profile, so this does not protect against profile access.

## Explicitly Excluded

- AliExpress cookies, access tokens, and authorization headers.
- Saved credentials in diagnostics, exported reports, run state, or Chrome Sync.
- Full URLs containing query strings or fragments in diagnostics exports.
- Raw page HTML, product descriptions, account names, email addresses, and unrelated page content.
- Network response bodies and private endpoint payloads.
- Analytics or external telemetry.

## Export Rules

Diagnostics exports contain only:

- Run/task state, timing, evidence kind, and sanitized error text.
- Allowlisted route summaries with query strings removed.
- Selector/report booleans and bounded counts.
- Stats account state, freshness, source kind/path, history count, and sanitized warnings.
- Bounded, sanitized log entries.

Exported text redacts URL query strings, email-shaped values, and token/secret/password/authorization/cookie key values. Saved credentials are not part of the diagnostic/export data model. Export is initiated by an explicit user action from the popup.

## Retention

- History is bounded to at most six months and 500 entries, with a user-configurable shorter history window.
- Diagnostics are retained for the configured 1-to-365-day window and are capped by the existing report/log limits.
- Users can clear history and diagnostics independently from the options page.
- Clearing diagnostics does not stop or mutate an active automation run.

## Permissions

The extension uses AliExpress host access for controlled navigation, DOM observation, and the page-context MTop bridge running in an existing coin tab. `login.aliexpress.com` access is used only to fill saved credentials in AliExpress's login document inside an owned manual probe or automation tab. The bridge reads the page's authenticated MTop token only in page context and does not send stats or credentials to any third party. `debugger` remains a prototype permission for mobile identity/trusted input and must be reassessed before distribution. `notifications` is used only for user-selected run-state notifications and does not transmit data externally.
