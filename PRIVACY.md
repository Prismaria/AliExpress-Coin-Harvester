# Privacy Policy

Last updated: September 29, 2026

Ali Coin Harvester does not sell, share, or transmit your AliExpress data to the developer or to third-party analytics services.

## Data Stored in Chrome

The extension stores user-selected settings, coin balance and savings snapshots, bounded coin history, automation state, sanitized diagnostics, and execution logs. These values are used only to provide the extension's features and can be cleared from the extension settings.

If you choose to save AliExpress sign-in details, the extension encrypts the account name and password with AES-256-GCM and stores the encrypted record and a randomly generated encryption key in this Chrome profile. These details are not stored in Chrome Sync or sent to the developer or analytics services. The key is stored alongside the encrypted record, so this does not protect credentials from someone who can access your Chrome profile or extension runtime. The extension's service worker decrypts the record to show the saved account name in Settings and to fill AliExpress's sign-in form when automation or the manual mobile probe encounters a login prompt.

Automation settings may be stored by Chrome Sync when sync is enabled on your Chrome profile. The developer does not receive those settings.

## AliExpress Pages

The extension reads the AliExpress pages needed to display coin information and perform the requested coin workflow. If you save sign-in details, it also fills them into AliExpress's login document in a controlled tab. It may access an authenticated page-context token required for AliExpress's own stats request, but it does not save or send that token to the developer or another service.

The extension does not collect or store AliExpress cookies, session tokens, payment details, or unrelated page content. Saved sign-in details are optional and handled as described above. When automatic sign-in is used, the details are entered into AliExpress's own sign-in page. Diagnostics remove query strings and redact token-shaped values before they are shown or exported.

## Contact

For questions or privacy requests, open an issue at [Ali Coin Harvester on GitHub](https://github.com/Prismaria/AliExpress-Coin-Harvester/issues).
