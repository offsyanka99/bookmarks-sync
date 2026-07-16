# Privacy Policy — Bookmarks Sync

**Browser extension** (Chrome, Brave, Firefox)  
**Last updated:** 15 July 2026  
**Project:** https://github.com/offsyanka99/bookmarks-sync

## Single purpose

This extension syncs the user’s browser bookmarks with a **self-hosted Bookmarks Sync server** that the user (or their administrator) configures.

## Does this extension collect user data?

**Yes.** It handles bookmark data and connection settings so sync can work. It does **not** send that data to the extension developer by default, and it does not include advertising or third-party analytics.

## What data is handled

- **Bookmarks** — titles, URLs, folders, and order. Read from the browser and sent to *your* server when you sync.
- **API base URL and API key** — stored only in this browser’s extension storage so the extension can reach your server.
- **Sync settings** — strategy, intervals, failsafe options, and local matching preferences (e.g. match-by-URL); stored in extension storage on this device.
- **Technical labels** — optional request headers (e.g. browser name, extension version) sent only to your configured server for its own logs.

## Where data goes

- **On this device:** settings and keys in the browser’s extension storage.
- **On the network:** only to the API base URL *you enter* (your self-hosted server).
- **Not to the developer:** the extension author does not operate a default cloud that receives your bookmarks or API keys.

## What we do not do

- We do not sell user data.
- We do not use bookmarks for advertising.
- We do not require an account with the extension developer.
- We do not ship built-in analytics or crash reporting to third parties.

## Permissions and network access

The extension may request optional host access for the origin of the API URL you configure. That access is used only to call your Bookmarks Sync server (for example health checks and bookmark sync APIs).

## Server you run

If you host the Bookmarks Sync server, that server stores bookmarks under *your* access control, backup, and retention practices. This policy covers the browser extension; your server deployment is your responsibility.

## Contact

Questions and issues: https://github.com/offsyanka99/bookmarks-sync/issues
