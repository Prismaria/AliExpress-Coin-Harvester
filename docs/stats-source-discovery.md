# Stats Source Discovery

Status: Page-context MTop bridge implemented; live authenticated bridge behavior remains to be validated.

## Current Evidence

- Primary source: a page-context MTop bridge running in the existing coin tab. It retrieves the authenticated balance, savings, earned flow, spent flow, and expired-account responses without opening a stats-only tab.
- Logged-out state: redirect to `https://www.aliexpress.com/p/ug-login-page/login.html`.
- Route classification: `stats`.
- Supplied DOM values are present in HTML-shaped markup at:
  - `.coin-info-content-head-text` for the current coin count.
  - `.coin-info-content-money-num` for current savings.
  - `.coin-history-head-subtitle` for lifetime savings.
  - `.coin-history-content-data-list .data-history-item-content` for history rows.
- The supplied stats snippet does not establish whether the live values are server-rendered or inserted after an XHR.
- The supplied history snippet does not expose category metadata, so rows without category markers are classified as `unknown`.

## Acquisition Decision

The main coin tab receives a request through the isolated content script and forwards it to a `MAIN`-world page-context bridge with `window.postMessage`. The bridge reads the page's MTop token cookie, signs fresh requests, uses JSONP so the request has the page's normal first-party context, retries once after `FAIL_SYS_TOKEN_EXOIRED`, and paginates history until a short page is returned or the bounded safety limit is reached. The service worker asks the automation tab for the final snapshot before closing it. A manually opened mobile probe is used for an explicit stats refresh when no automation run is active.

The bridge stores only normalized stats and sanitized source metadata. It never stores credentials, cookies, signed MTop URLs, or full query strings. MTop history preserves numeric timestamps, event types, stable spent-transaction IDs, and separate earned, used, and expired categories. If the user has no open coin probe when a manual refresh is requested, the cache preserves prior usable values as stale when available.

## Required Live Captures

- Authenticated page with non-zero values and at least two history dates.
- Authenticated page with zero or otherwise empty account values.
- Logged-out redirect, including the final URL and origin.
- Loading state before stats values are rendered.
- Any malformed or partial page observed during a failed load.
- At least one history view exposing Earned, Used, or Expired category metadata, if the live page provides it.

Record live bridge results in this file and add redacted MTop fixtures before relying on the bridge for production refreshes.
