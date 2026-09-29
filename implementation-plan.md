# Saved Credentials and Automatic AliExpress Sign-In — Implementation Plan

## Goal

Let users save their AliExpress email and password in Settings so an automation run can attempt the ordinary email-and-password sign-in flow when the Coins page presents its login button. Keep credentials out of synced settings, content-script reports, diagnostics, run history, and logs. If AliExpress asks for a CAPTCHA, email code, passkey, or other user verification, stop and hand control to the user rather than trying to bypass it.

The same flow applies to a user-opened manual mobile Coins probe. It must not start on desktop probes, task child tabs, or automation-owned tabs; those continue through their existing paths.

## Security Decision and Limits

Use Web Crypto AES-256-GCM with a fresh 96-bit IV for every encrypted credential write. Keep the encrypted credential record and its random 256-bit key in `chrome.storage.local`, as in the proposed architecture. Keep credential reads, key handling, encryption, and decryption in the service worker; keep `chrome.storage.local` restricted to trusted extension contexts.

This is defense in depth against plaintext appearing in storage, sync, or routine diagnostics. It is **not strong encryption against someone who can read the Chrome profile**: the decryption key is stored beside the ciphertext. The extension cannot protect a saved password from malware or a person with access to the unlocked profile and extension runtime. Do not describe this design as protecting against profile/device compromise. A future vault unlocked by a separate user-held passphrase could provide stronger at-rest protection, but it would require unlocking after browser restarts and would limit unattended scheduled sign-in.

AliExpress remains responsible for authentication. The extension must not store cookies, session tokens, one-time codes, payment information, or CAPTCHA answers.

## Storage Design

Add dedicated credential-storage constants and a small credential module, separate from `AutomationSettings` and `chrome.storage.sync`.

Suggested versioned records in `chrome.storage.local`:

```text
credentialKey: base64(random 32-byte AES key)
credentials: {
  version: 1,
  algorithm: "AES-GCM",
  iv: base64(random 12-byte IV),
  ciphertext: base64(AES-GCM(JSON({ username, password })))
}
```

- Use a 128-bit GCM authentication tag and bind the schema/version as additional authenticated data.
- Generate the key only when there is no existing encrypted credential record.
- If a credential record exists but its key is missing, malformed, or cannot decrypt it, fail closed. Do not silently generate a replacement key and overwrite the record; show a recovery message and let the user clear and re-enter credentials.
- Store credentials only in local extension storage. Never put them in the sync settings object.
- Set and retain `chrome.storage.local` access level `TRUSTED_CONTEXTS`; the service worker is the only component that reads the key or decrypts the record.
- If Chrome cannot restrict local storage to trusted contexts, disable credential saving/decryption and keep manual sign-in available. Clearing saved credentials may remain available.
- Never include credentials, ciphertext, key material, or form values in exceptions, debug reports, exported diagnostics, or automation logs.

## Message and Trust Boundaries

Add narrowly scoped messages for credential status, save, and clear. Validate that save/status/clear requests come from this extension's Options page. The Options page may receive a saved/not-saved status and the account identifier for display, but it must never receive a decrypted password. The password field is write-only: leave it blank when Settings loads.

Use a separate automation command to request the saved credential for the currently owned main automation tab. The service worker must verify the active automation run/session and target tab before decrypting and sending the credential to the content script. Do not add a generic “get password” response or make credentials available to arbitrary AliExpress tabs, child tabs, popup UI, or diagnostics.

The plaintext will necessarily pass through memory and the login form DOM while signing in. Keep its lifetime short, do not cache it in module state or run state, and clear local references after submission where practical. The page can observe values entered into its own form; this is intrinsic to browser-based sign-in.

## Settings UI

Add an **AliExpress sign-in** panel to `src/options/index.html`:

- Email/account field.
- Password field with `type="password"`, `autocomplete="new-password"`, `maxlength="40"` (matching the supplied sign-in DOM), and no prefilled value.
- Explicit **Save credentials** action; do not autosave credentials alongside ordinary preference changes.
- **Clear saved credentials** action with clear confirmation/status feedback.
- A status label such as “Credentials saved for …” that never reveals the password.
- Concise explanation that credentials stay in this Chrome profile, are encrypted before storage, and are used only to attempt AliExpress sign-in. Include the security limitation above in the product privacy explanation.

Saving with a blank password must not erase or replace an existing password accidentally. Define the save behavior explicitly in the UI: require both fields for initial save; for an existing record, either require both again to replace the account or provide a separate “update password” action. Prefer the simple first implementation: require both values to save/update; leave the current record unchanged if validation fails. Clearing removes both the encrypted record and its key.

## Login Detection and Sign-In Flow

Extend the existing coin-page login observation and `waiting_for_login` handling. When the main Coins page reports the known AliExpress login button:

1. If no credentials are saved, retain the current behavior: pause with `waiting_for_login`, notify according to the existing notification setting, and let the user sign in manually and resume.
2. If credentials are saved, begin one guarded sign-in attempt in the owned main tab. Do not start concurrent attempts for the same run.
3. Click the verified Coins-page login button and wait five seconds. First inspect the parent Coins document for an inline right-side sign-in drawer; if the form is in AliExpress's separate login document, locate its controlled frame and continue there.
4. Identify the flow by semantic attributes and visible labels, not generated class names where possible:
   - Account: `input[autocomplete~="username"]`, `input[name="account"]`, or the visible “Email or phone number” field.
   - Password: `input[type="password"]` (prefer the stable `name`/`id` and accessible label when present, including `#fm-history-login-password`). The remembered-account variant may not expose an editable email field; use the already-selected account and fill only its password.
   - Actions: visible enabled buttons named **Continue** and **Sign in**.
5. Support both observed states: the initial email-and-Continue panel, and the password panel after Continue. Fill email, wait for an enabled Continue button, submit, re-observe the drawer, then fill the password and submit only when the expected password panel is present.
6. Focus and select each recognized field, then use the existing controlled-tab debugger permission to insert text as user input so AliExpress's controlled form state observes it. If trusted input is unavailable, fall back to the native setter plus bubbling `input`/`change` events. Never submit a form whose fields or action do not match the expected state.
7. If the form lives in the controlled `login.aliexpress.com/msite.html` or AliExpress `/p/ug-login-page/` frame, send the form command only to that allowlisted login frame. After submit, verify sign-in from the main Coins page; never infer success from the form closing alone.
8. If successful sign-in redirects the tab to the desktop homepage, navigate back to `COIN_INDEX_URL` through the session's mobile User-Agent navigation helper.
9. Wait for evidence that authentication succeeded: the sign-in drawer/login prompt is gone and a fresh coin-page observation no longer detects the login button and reaches a known signed-in state. Then continue the same run from daily collection/task-drawer opening without restarting already completed work.

Recognize and stop for CAPTCHA/security verification, email/SMS code, passkey, social login, account lock, password rejection, unexpected screen, or timeout. Keep the run paused in an actionable login/manual state, leave the controlled tab available, and ask the user to complete the step. Never attempt CAPTCHA solving, OTP retrieval, security-question guessing, or a hidden/private authentication endpoint. On resume, re-check the signed-in page state before continuing.

## Failure and Recovery Behavior

- Missing credentials: use the current manual login path; do not fail the entire scheduled task as a terminal error.
- Decryption/key/storage error: do not attempt sign-in; pause and explain that saved credentials must be cleared and re-entered.
- Login panel does not match known stages: stop safely; do not click by position or guess.
- Rejected credentials or verification requirement: pause and expose a sanitized reason; never log form values or server response bodies.
- Browser/session closes during sign-in: resume using the existing interrupted-run recovery, then observe the page again. Do not assume a prior submit succeeded.
- Stop/cancel: clear pending in-memory references and preserve or remove saved credentials only according to the user's explicit clear action.

## Implementation Areas

1. `src/shared/constants.ts` and `src/shared/types.ts`: storage keys, versioned encrypted record type, and narrow credential messages/results.
2. New `src/background/credential-vault.ts`: key generation, AES-GCM encrypt/decrypt, input validation, storage access, and clear/status operations.
3. `src/background/service-worker.ts`: trusted sender checks, credential message handling, run/session authorization for sign-in, controlled-tab trusted text insertion, and continuation/pause routing.
4. `src/options/index.html`, `src/options/main.ts`, and `src/options/options.css`: explicit credential form, save/clear UI, status, and security wording.
5. `src/content/dom-contracts.ts`, `src/content/automation-controller.ts`, new `src/content/login-frame.ts`, `public/manifest.json`, and `src/shared/types.ts`: semantic sign-in stage observations, safe input handling, login-frame routing, outcome evidence, and manual-challenge state.
6. Tests and fixtures: encryption/vault behavior, drawer stages, sign-in transitions, no-credential fallback, paused verification, and continuation after verified authentication.
7. `PRIVACY.md`, `docs/privacy-review.md`, README/settings copy, and the local Chrome Web Store listing document if maintained: replace claims that credentials are never saved with accurate local-storage, encryption, and threat-model wording. Do not put credentials in test fixtures or docs.

## Verification Plan

### Crypto/storage tests

- Encrypt/decrypt round trip for Unicode account names and passwords.
- A fresh IV is generated for every write; same plaintext does not produce the same envelope.
- Modified ciphertext, IV, version/AAD, or key fails authentication without returning partial plaintext.
- Missing key with an existing record fails closed and does not overwrite data.
- Clear removes both credential and key records.
- Credential messages do not modify `AutomationSettings` or `chrome.storage.sync`.
- No key, password, ciphertext, or submitted form value appears in logs/reports/diagnostic exports.

### DOM/automation tests

- Detect initial drawer state and saved-email/password state using fixtures based on the supplied markup, with account values replaced by placeholders.
- Advance email → password only after the expected Continue transition; submit only from the expected password state.
- Handle already-populated email, login button absent, button disabled, stale drawer, wrong-password alert, CAPTCHA/security prompt, email code, and unknown UI without unsafe clicks.
- Missing credentials preserves manual login and existing resume behavior.
- Successful login requires signed-in coin-page evidence before the same automation run proceeds.
- A manual mobile main Coins probe uses the same saved-login flow once when logged out, and can retry after the user saves/updates credentials.
- Decryption failure, timeout, and user challenge pause safely without logging secrets.

Run focused vault/DOM tests first, then `npm run check` (typecheck, all tests, build, generated-package validation). Review the final diff for accidental secrets and confirm `git diff --check`.

## Acceptance Criteria

- Users can save, replace, and clear AliExpress credentials in Settings; password is never re-displayed.
- No credentials are stored in Chrome Sync or plaintext in extension storage.
- The random AES key and versioned AES-GCM envelope are local-only, and the UI accurately states their protection limits.
- An owned automation run can complete the observed email → password flow and continue only after signed-in state is verified.
- Missing credentials and all unsupported verification/security states hand off cleanly to the user.
- No CAPTCHA, OTP, passkey, or authentication-bypass behavior is introduced.
- Existing manual login, notifications, pause/resume, scheduling, and unrelated automation remain intact.
