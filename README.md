# Restaurant Depot Scraper (local)

Local Node.js + Playwright port of the Apify actor in `reference/apify-actor.js`. Logs into
restaurantdepot.com (Azure B2C) per restaurant, downloads `.xlsx` receipts, uploads them to a
shared Google Drive, and writes parsed line items into Supabase.

## Requirements

- Node.js 24+
- A Chromium build for Playwright (installed via `npx playwright install chromium` — not run yet,
  do this after `npm install`)

## Setup

```
npm install
npx playwright install chromium
cp .env.example .env   # then fill in real values
```

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase `service_role` key (server-side only) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | One central Google Drive account, shared across all clients |
| `DATE_RANGE` | Must match an option label in the receipts page date filter |
| `HEADLESS` | `false` to watch the browser (debugging login/selectors) |
| `DRY_RUN` | `true` to scrape + parse but skip Drive uploads and Supabase writes |
| `SINGLE_CLIENT` | Restaurant name (exact match against `restaurants.name`) to process only that client |
| `BROWSER_CHANNEL` | Empty (default) launches Playwright's bundled Chromium — no extra install needed. Set to `chrome` to launch system-installed Google Chrome instead, which requires Chrome to already be installed locally and offers a slightly more "real browser" fingerprint if Restaurant Depot's Azure B2C anti-bot checks ever get stricter. |

## Scripts

| Command | Behavior |
|---|---|
| `npm start` | Full run: all active restaurants from Supabase |
| `npm run dry` | Same as `start` with `DRY_RUN=true` forced |
| `npm run one` | Same as `start`; combine with `SINGLE_CLIENT` in `.env`, or `npm run one -- "Turmeric STL"` |
| `npm run test-login` | Logs into one client (first active, or `SINGLE_CLIENT`), saves storageState, exits — no scraping |

## Auth persistence

After a successful login, session state is saved to `auth-state/{restaurantId}.json`. Subsequent
runs load that file and skip the Azure B2C login flow if the session is still valid, falling back
to a fresh login otherwise. This directory is gitignored — it holds live session cookies.

## Folders

- `auth-state/` — per-restaurant Playwright `storageState` JSON (gitignored)
- `tmp/` — scratch downloads, deleted after each successful upload (gitignored)
- `logs/` — one JSON-lines file per run, `logs/{ISO-timestamp}.jsonl` (gitignored)
- `reference/apify-actor.js` — original Apify actor this project is ported from

## Differences from the reference actor

- Dropped the dead `input[id="signInName"]` selector from the login field probe.
- Row processing now waits 500ms before each download click and retries the
  download+upload sequence up to 2 times with backoff — fixes the intermittent
  "File not found: ." failures seen on fast successive rows.
- Playwright `storageState` is persisted per restaurant so repeat runs can skip login.
- Structured JSON-line logs per run in addition to console output.
