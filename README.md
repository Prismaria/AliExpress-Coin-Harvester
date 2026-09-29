# Ali Coin Harvester

> #### Automate the repetitive parts of collecting AliExpress Coins.

Ali Coin Harvester collects the daily streak reward, works through supported **Earn more coins** tasks, and records what it completed.

You can start the automation from the popup or set a daily schedule. If the browser or PC is unavailable at the scheduled time, the automation can resume when Chrome is available again.

## Automated Routine

- Collects the streak check-in: 10 coins on day 1, 20 on day 2, 30 on day 3, 40 on day 4, and 50 each day from day 5 onward.
- Can use sign-in details saved in Settings for regular email-and-password login in automation or the manual mobile probe; security checks still need you.
- Completes the separate `+1` Daily check-in task from the task drawer.
- Handles sponsored items, surprise items, recently viewed items, the Coins Savings Recap, Super discounts, coin search, coupons and shopping credits, and the daily quiz.
- Completes repeated task rounds instead of stopping after the first reward.
- Retries temporary failures and stops when it cannot verify a safe next step.
- Updates balance, savings, coin history, task progress, and automation results in the popup.

## Potential Rewards

Once the streak reaches day 5, the regular check-in is worth `50 coins` per day. The captured task lineup adds another `57-61 coins`:

| Reward source                 | Coins each | Times per day | Daily total |
| ----------------------------- | ----------:| -------------:| -----------:|
| Streak check-in, day 5 onward | 50         | 1             | 50          |
| Separate Daily check-in task  | 1          | 1             | 1           |
| Explore sponsored items       | 5          | 2             | 10          |
| Browse surprise items         | 5          | 2             | 10          |
| Browse recently viewed items  | 5          | 1             | 5           |
| View your Coins Savings Recap | 5          | 1             | 5           |
| View Super discounts          | 5          | 3             | 15          |
| Search for what you love      | 5          | 1             | 5           |
| Coupons and shopping credits  | 5          | 1             | 5           |
| Daily quiz challenge          | 1-5        | 1             | 1-5         |
| **Automated task subtotal**   |            |               | **57-61**   |
| **Potential daily total**     |            |               | **107-111** |

If that same lineup remains available every day:

| Time               | Check-in only | Automated tasks | Combined total |
| ------------------ | -------------:| ---------------:| --------------:|
| 1 day              | 50            | 57-61           | 107-111        |
| 1 week             | 350           | 399-427         | 749-777        |
| 1 month (30 days)  | 1,500         | 1,710-1,830     | 3,210-3,330    |
| 3 months (90 days) | 4,500         | 5,130-5,490     | 9,630-9,990    |
| 1 year (365 days)  | 18,250        | 20,805-22,265   | 39,055-40,515  |

These figures use the day-5-and-later check-in amount and the captured task rewards. They are examples, not guaranteed earnings; AliExpress can change task availability, reward amounts, streak rules, and account eligibility.

## Quick Access

Press `Alt+Shift+A` to open the mobile Coins page in a compact Chrome window. Change the shortcut at `chrome://extensions/shortcuts`.

## Current Limits

This is an early release, not complete coverage of every Coins workflow. Prize Land and Merge Boss are recognized but still require manual play and are disabled by default. AliExpress page changes can also interrupt otherwise supported tasks. Broader task support and better recovery are planned.

The extension does not place orders or make purchases. Settings, results, and diagnostics stay in the browser; there is no analytics or external telemetry.

## Requirements

- Google Chrome 120 or later.
- An AliExpress account signed in in Chrome.

## Install a Release

1. Download [`ali-coin-harvester-v0.95.zip`](https://github.com/Prismaria/AliExpress-Coin-Harvester/releases/download/v0.95/ali-coin-harvester-v0.95.zip) from the Releases page.
2. Unzip it to a permanent folder. Do not load the ZIP file itself.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped extension folder.
5. Sign in to AliExpress, open the extension popup, and start the automation or set a schedule in **Options**.

The release ZIP is also the clean package prepared for Chrome Web Store submission.

## Install From Source

1. Clone this repository.
2. Run `npm install`.
3. Run `npm run check`.
4. Open `chrome://extensions`, enable **Developer mode**, and load the generated `dist` folder.

## Development

```text
npm install
npm run check
```

`npm run check` runs the tests, builds the extension, and checks the generated package.

Ali Coin Harvester is an independent project and is not affiliated with AliExpress.
