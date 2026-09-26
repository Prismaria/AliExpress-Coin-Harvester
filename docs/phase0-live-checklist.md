# Phase 0 Live Checklist

The supplied chat snippets and local files are already enough for the first-pass DOM contracts. Phase 0 now needs browser observations, not more static HTML from the user.

## Already Covered

- `tests/fixtures/coin-index.html` supplies the unchecked `#signButton` and current-day card.
- `tests/fixtures/task drawer.html` supplies every requested task group ID, title, progress examples, active GO state, and representative completed state.
- `tests/fixtures/surprise_items.html` supplies the route-scoped product waterfall and card click target.
- The chat supplies the `Mission Completed` element and the initial quiz question/options.
- The chat supplies the stats selectors and representative values.
- The login page DOM is not required; redirect URL classification is sufficient.
- Overlay detection uses a global search for visible normalized text, so a stable overlay class is not required.

## First Reported Live Observation

- The compact inner viewport measured `418 x 815` with DPR `1.6949999332427979`.
- The probe displayed the configured mobile DNR target User-Agent, but DevTools Network has not verified the actual request header.
- JavaScript still reported desktop Chrome `152`, UA-CH mobile was `false`, and platform was Windows; this is expected without CDP emulation.
- Touch points were `0` and the touch event API was absent; this is expected from a narrow window alone.
- The coin page reported `document.readyState = complete`, body text length `11870`, `#root` present, `#signButton` present, and `collect / collectable` state.
- The task drawer was not detected before it was opened, which is expected for the initial coin-page state.

## Still Genuinely Needed

1. Load `dist/` as an unpacked extension and verify in DevTools Network that the first coin-page request carries the configured mobile User-Agent. The content-script report intentionally shows JavaScript-visible UA separately because DNR does not change `navigator.userAgent`. Answer: DNR target is displayed; packet header has not been checked.
2. Record the actual `innerWidth`, `innerHeight`, device pixel ratio, and touch values in the compact window. Confirm that the mobile coin DOM loads there. Answer: `418 x 815`, DPR `1.6949999332427979`, 0 touch points, and the coin DOM loaded.
3. Observe the live transition from Collect to Earn more coins and record which DOM mutation proves success. Answer: haven't checked.
4. Open the task drawer once with active rows and once with completed rows. The same row-state classifier can be reused across tasks; only validate that `data-groupid`, progress, and dimmed blank action behavior are consistent. Answer: haven't checked.
5. Confirm the task navigation policy: Daily quiz, Merge Boss, Items at $0.1 to get, and Browse surprise items require a child tab. Other tasks should be treated as direct-credit tasks; close any incidental allowlisted child after one second.
6. Confirm whether the parallel execution setting can dispatch independent GO actions without task-order dependencies, and whether each row reports progress independently.
7. On Surprise items, observe the live visible `next round` text, how it is dismissed, whether the second round requires different cards, and the transition to the supplied Mission Completed element. No full overlay HTML is needed if visible-text detection and postcondition are sufficient. Answer: haven't checked.
8. On the supplied quiz, answer the known question once and record how a correct answer is represented before closing. If the result cannot be observed, leave quiz completion as manual-action-required rather than guessing. Answer: haven't checked.
9. Open the mobile coin probe, trigger a stats refresh after the page settles, and verify in DevTools Network that the page-context JSONP calls reach `acs.aliexpress.com` with fresh timestamps/signatures and return balance, savings, earned, spent, and expired data. Confirm that the main automation run performs the same refresh after its final task and before closing the main tab. No private endpoint capture should be committed.
10. Verify one-second incidental-child closure and the five-minute assisted-child timeout without making purchases or completing game orders; do not apply the app-only 15-second subtitle as a desktop dwell requirement.
11. Test a worker suspension/reload during a probe window and confirm that current-session ownership/rules reconcile without controlling restored user tabs.

## Run Locally

From the extension project directory:

```text
npm install
npm run check
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory. Open the extension popup and choose **Open mobile probe** for passive discovery or **Run daily automation** for a logged run.

The passive probe performs no reward clicks. The separate automation action performs only verified workflow clicks and records its execution log. Use the options page to mark completed live checks.
