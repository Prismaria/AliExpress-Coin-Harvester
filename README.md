# Ali Coin Harvester

A safety-first Chrome extension for collecting AliExpress Coins and keeping an eye on your balance and coin history.

## What It Does

- Collects the daily check-in reward.
- Runs supported coin-page tasks manually or on a schedule.
- Tracks balance, savings, history, progress, and run diagnostics.
- Stops when a page state or completion signal is unclear instead of guessing.
- Keeps settings and diagnostics in your browser; there is no analytics or external telemetry.

The extension never places orders or purchases. Some AliExpress tasks still require manual action, and site changes may affect task support.

## Requirements

- Google Chrome 120 or later.
- An AliExpress account signed in in Chrome.

## Install From Source

1. Clone this repository.
2. Run `npm install`.
3. Run `npm run check`.
4. Open `chrome://extensions` and enable **Developer mode**.
5. Choose **Load unpacked** and select the generated `dist` folder.

## Use It

1. Sign in to AliExpress.
2. Open the extension popup and run the daily automation, or open **Options** to set a schedule.
3. Review the run status and execution log when the automation finishes.

## Development

```text
npm install
npm run check
```

`npm run check` runs type checking, tests, the extension build, and generated-package validation.

Ali Coin Harvester is an independent project and is not affiliated with AliExpress.
