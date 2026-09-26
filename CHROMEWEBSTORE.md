# Chrome Web Store Listing: Ali Coin Harvester

Last updated: September 26, 2026

## Store Listing

**Extension Name**

Ali Coin Harvester

**Short Description**

Collect AliExpress Coins, track your balance, and automate supported coin tasks with safety checks.

**Detailed Description**

Ali Coin Harvester helps you collect AliExpress Coins and keep track of your coin activity from Chrome.

Collect the daily check-in reward, run supported coin-page tasks manually or on a schedule, and review your balance, savings, history, task progress, and run diagnostics in one place. The extension stops when a page state or completion signal is unclear instead of guessing. Some tasks may still require manual action.

To use it, sign in to AliExpress, open the extension, and start a run or set a schedule in Options. The extension never places orders or purchases.

Settings, stats, history, and diagnostics stay in Chrome. The extension does not sell data, use analytics, or send AliExpress credentials or page data to the developer or third parties. See the [privacy policy](https://github.com/Prismaria/AliExpress-Coin-Harvester/blob/main/PRIVACY.md).

For support, visit the [GitHub repository](https://github.com/Prismaria/AliExpress-Coin-Harvester) or [open an issue](https://github.com/Prismaria/AliExpress-Coin-Harvester/issues).

**Category**

Shopping

**Single Purpose**

Collects AliExpress Coins and automates supported coin-page tasks with user-visible safety checks.

**Primary Language**

English

## Graphics and Assets

| Asset | Dimensions | Status | Filename |
|---|---:|---|---|
| Store icon | 128 x 128 PNG | Ready | `public/icons/icon-light-128.png` |
| Screenshot 1 | 1280 x 800 or 640 x 400 | Needed | Capture the popup showing balance and automation status |
| Screenshot 2 | 1280 x 800 or 640 x 400 | Needed | Capture the execution log and last-run details |
| Small promo tile | 440 x 280 | Optional | Not created |

Screenshots must be captured from the current `0.94` build before submission. They should show the extension in use without exposing account details, tokens, or private URLs.

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `alarms` | permission | Runs the user-selected daily schedule, bounded retries, navigation watchdogs, and periodic stats refreshes while the popup is closed. |
| `declarativeNetRequestWithHostAccess` | permission | Applies the configured mobile request headers only to extension-controlled AliExpress tabs so the coin workflow can load its mobile experience. |
| `storage` | permission | Stores settings, cached stats, bounded history, run state, sanitized diagnostics, and temporary tab ownership needed to resume or clean up automation. |
| `tabs` | permission | Creates and manages the controlled AliExpress tabs and identifies an existing AliExpress tab for the user-requested stats refresh. |
| `scripting` | permission | Adds the stats bridge to an existing matching AliExpress tab when the user requests a stats refresh. |
| `webNavigation` | permission | Watches allowlisted task navigation so the extension can attribute child tabs to the task that opened them and verify completion. |
| `debugger` | permission | Applies mobile emulation to controlled tabs and sends trusted input for supported workflows. It is never used on unrelated tabs. |
| `system.display` | permission | Positions the compact automation and child windows on the available display work area. |
| `notifications` | permission | Shows optional notifications for user-selected run completion, failures, or login-required states. |
| `https://m.aliexpress.com/*` | host permission | Reads and controls the mobile AliExpress coin page and allowlisted mobile task pages requested by the user. |
| `https://www.aliexpress.com/*` | host permission | Reads the desktop stats page and matching AliExpress pages used for stats and task workflows. |
| `http://best.aliexpress.com/*` | host permission | Supports the existing AliExpress redirect route used by some task links. |

## Privacy and Data Use

**Does the extension collect user data?**

No developer collection. The extension processes AliExpress page data locally and does not transmit it to the developer or third-party analytics services. User-selected settings may be handled by Chrome Sync when Chrome Sync is enabled.

The extension does not sell data, use it for purposes unrelated to its core functionality, or use it for creditworthiness or lending purposes.

## Privacy Policy

https://github.com/Prismaria/AliExpress-Coin-Harvester/blob/main/PRIVACY.md

## Distribution

**Visibility:** Public

**Regions:** All regions

## Developer Info

**Publisher Name:** Prismaria

**Contact Email:** allenyan77@gmail.com

**Support URL:** https://github.com/Prismaria/AliExpress-Coin-Harvester/issues

**Homepage URL:** https://github.com/Prismaria/AliExpress-Coin-Harvester

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.94 | September 26, 2026 | Initial public release with daily check-in, supported task automation, stats, history, diagnostics, and scheduled runs. | Draft |

## Review Notes

### Known Limitations

- AliExpress page changes can affect supported selectors and task flows.
- Some workflows require manual action and are intentionally not completed automatically.
- The `debugger` permission is used for controlled mobile identity and trusted input and should be reviewed carefully during submission.
- Store screenshots still need to be captured from the release build.
