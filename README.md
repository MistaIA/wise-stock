# Stock & Market n8n: 🌙 stock picks and African markets on Telegram

n8n 2.46.6 workflows that send Telegram briefs on:

- **1 to 2 US stocks a day that pass the 🌙 screen** (debt and cash each under 30 % of market cap, interest income under 5 % of revenue, no excluded business), the ones with the highest score, from Financial Modeling Prep (FMP) data;
- **African markets**: NGX (Nigeria, with the Dangote companies), BRVM (West Africa) and BVMAC (Central Africa), each with its **headlines**, what **X (Twitter)** says, the **mood** of both, and **one 🌙 share to look at**;
- **the Dangote Petroleum Refinery IPO** (headlines and X posts from the last 12 hours, their mood, and the Dangote share prices on NGX);
- plus your existing **WF-11 Telegram assistant**, which can now also call the three briefs as tools.

A Vercel dashboard shows the same briefs on the web.

> **n8n cannot run on Vercel.** Vercel runs short functions; n8n is a server that must run all the time (schedules, webhooks, its database). So n8n runs on your PC, on a Docker host or on Railway, and Vercel hosts the dashboard, a cached proxy to n8n and a daily "is n8n up?" check. This is the same split as your AutoFlow app (frontend on Vercel, backend on Railway).

New here, or picking up from another agent? Read [JOURNAL.md](JOURNAL.md) first (newest entry on top). Information only, not financial advice.

## How the pieces connect

```
                      ┌────────────────────────── n8n 2.46.6 (your PC, Docker or Railway) ─────────────────────────┐
 NGX price list ─────►│ SM-02 Africa brief      Mon–Fri 18:00 ──┐                                                   │
 brvm.org table ─────►│                                        ├──► Telegram (TELEGRAM_CHAT_ID)                   │
 BVMAC bulletin PDF ─►│ SM-01 US stock picks    Mon–Fri 07:30 ──┤                                                   │
 FMP (US stocks) ────►│ SM-03 Dangote watch     daily 08:00, 18:00                                                 │
 Google News RSS ────►│ WF-11.2 Telegram assistant (answers your messages; tools: SM-01..03, WF-11.1 chart)       │
 X via a Nitter ─────►│ SM-04 Brief API  GET /webhook/market-brief (header X-Brief-Secret) runs SM-01, 02 and 03 │
 mirror (no account)  └──────────────────────────────────────────────▲───────────────────────────────────────────┘
                                                                     │ (n8n must be reachable from the internet)
 Browser ──► Vercel: public/index.html ──► /api/brief (CDN cache 6 h) ┘    Vercel cron 06:00 UTC ──► /api/health-cron
                                                                           (Telegram alert when n8n does not answer)
```

Times are Africa/Lagos (WAT, UTC+1).

| Workflow | File | What it does |
|---|---|---|
| SM-01 · US stock picks | [01-us-stock-picks.json](workflows/01-us-stock-picks.json) | Screens 10 large US tickers (Config node) with FMP statements, scores the ones that pass, sends the top 2 with an AI explanation (left out while there is no AI key). About 30 FMP calls per run (the free plan allows 250 a day). |
| SM-02 · Africa markets brief | [02-africa-markets-brief.json](workflows/02-africa-markets-brief.json) | Per market: watchlist (NGX: Dangote Cement, Dangote Sugar, NASCON, MTN, BUA Cement, Seplat), breadth and movers, the 🌙 share to look at, the mood, the latest headlines and X posts. BVMAC: the index and its 7 shares from the latest official bulletin (PDF). AI insights and ratings when there is an AI key. A source that is down is named in the brief; the rest still goes out. |
| SM-03 · Dangote watch | [03-dangote-watch.json](workflows/03-dangote-watch.json) | Refinery IPO headlines, X posts, their mood and the Dangote share prices; sends only when there is something new. Flags a new Dangote ticker on NGX (the refinery listing was expected around 8 Dec 2026). |
| SM-04 · Market brief API | [04-market-brief-api.json](workflows/04-market-brief-api.json) | Webhook for the Vercel dashboard: runs SM-02, SM-01 and SM-03 without sending to Telegram and returns the three briefs as JSON. |
| WF-11.1 · Stock chart analyst | [WF-11.1-stock-chart-analyst.json](workflows/WF-11.1-stock-chart-analyst.json) | Your chart tool (chart-img.com + OpenAI or Gemini vision), now with `EXCHANGE:TICKER` support and the key in a credential. |
| WF-11.2 · Telegram assistant | [WF-11.2-telegram-market-assistant.json](workflows/WF-11.2-telegram-market-assistant.json) | Your AI agent, with stockPicks, africaMarkets and dangoteWatch as extra tools. Answers only the chat in `TELEGRAM_CHAT_ID`. Needs an https address (see below). |

The workflow files are generated: edit `src/code/*.js` or `tools/build-workflows.mjs` (SM-01 to SM-04) or `tools/upgrade-wf11.mjs` (WF-11, from `src/original/`), then run `node tools/build-workflows.mjs` and `node tools/upgrade-wf11.mjs`. A line `// #include lib-feeds` in a `src/code` file pastes in `src/code/lib-feeds.js` (shared code; see [tools/code-files.mjs](tools/code-files.mjs)). SM-01 keeps its first workflow id (`smHalalPicks0001`), so a copy n8n already has is updated, not duplicated.

## Run it

Pick one. All three run the same start-up setup ([tools/first-run-setup.mjs](tools/first-run-setup.mjs)), which turns your keys into n8n credentials and imports and publishes the workflows.

### A. Your Windows PC (npm install, retried every hour)

1. Double-click `windows\install-n8n.cmd`. It gives n8n its own Node.js 24 (downloaded from nodejs.org and checked against its SHA-256 list) and installs n8n 2.46.6 with npm, all into `%LOCALAPPDATA%\n8n-sm`. A Node.js of your own (nvm-windows, fnm, Volta or the nodejs.org installer) is not used and not changed, so switching or upgrading it later cannot break n8n. No administrator rights, no Visual Studio. When the internet fails, a hidden scheduled task "n8n-sm install retry" tries again every hour for up to 30 days and removes itself once n8n is installed. Log: `%LOCALAPPDATA%\n8n-sm\install.log`.
2. Double-click `windows\check-sources.cmd`: it reads NGX, BRVM, BVMAC, the headlines, the X posts and the Dangote news from your PC right away and shows the briefs they give, no keys needed (see [Check the live sources](#check-the-live-sources)).
3. Copy `windows\n8n.env.example` to `windows\n8n.env` and fill in your keys (see [Keys](#keys)). A setting your copy doesn't have yet, such as `GEMINI_API_KEY`, can be added as a new `KEY=value` line.
4. Double-click `windows\start-n8n.cmd`, open http://localhost:5678 and create the owner account. Ctrl+C stops n8n.
5. Optional, start n8n hidden at every logon: `powershell -NoProfile -ExecutionPolicy Bypass -File windows\start-n8n.ps1 -RegisterAtLogon` (`-UnregisterAtLogon` removes it).

n8n keeps its data in `%LOCALAPPDATA%\n8n-sm\.n8n`. Back up that folder: the key in `.n8n\config` unlocks your saved credentials. Leave `N8N_ENCRYPTION_KEY` out of `n8n.env`.

Exit codes of `install-n8n.cmd`: 0 installed, 1 internet problem (the hourly retry is scheduled), 2 stopped on another error (the log says why), 3 another install run is busy. `-Loop` retries in the window instead of a scheduled task.

On your PC only the Telegram briefs and the editor work out of the box. The Vercel dashboard and the WF-11.2 assistant need n8n to be reachable from the internet over https, for example through a Cloudflare tunnel (then set `N8N_WEBHOOK_URL` in `n8n.env`) or by running it on Railway (C).

### B. Docker (PC or VPS)

```sh
cp .env.example .env          # fill it in: N8N_ENCRYPTION_KEY (openssl rand -hex 32), POSTGRES_PASSWORD, your keys
docker compose up -d --build  # n8n 2.46.6 + Postgres 17, editor on http://localhost:5678
```

The image is `n8nio/n8n:2.46.6` plus the workflows and the setup ([Dockerfile](Dockerfile)); the setup runs before n8n on every start and never blocks it. Optional: `docker-compose.runners.yml` runs Code nodes in n8n's separate task-runner container.

### C. Railway (always on, https)

Railway builds the [Dockerfile](Dockerfile) straight from your GitHub repo and runs it next to a Postgres database. Cost: a new account gets a $5 trial once (30 days); the Hobby plan is $5 a month, usage included up to $5.

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → `MistaIA/wise-stock`. Railway finds the Dockerfile and builds it. This first deploy has no settings yet; step 4 replaces it.
2. In the same project: **Create** → **Database** → **PostgreSQL**. Keep its name, `Postgres`.
3. Click the n8n service (named after the repo) → **Settings** → **Networking** → **Generate Domain**, port **5678**. Optional, further down in **Settings** → **Deploy**: **Healthcheck Path** `/healthz`.
4. Same service → **Variables** → **Raw Editor**. Paste this block, put your values after the `=` signs (the same keys as in `windows\n8n.env` on your PC; delete a line you have no value for), click **Update Variables**, then **Deploy**:

   ```
   PORT=5678
   DB_TYPE=postgresdb
   DB_POSTGRESDB_HOST=${{Postgres.PGHOST}}
   DB_POSTGRESDB_PORT=${{Postgres.PGPORT}}
   DB_POSTGRESDB_DATABASE=${{Postgres.PGDATABASE}}
   DB_POSTGRESDB_USER=${{Postgres.PGUSER}}
   DB_POSTGRESDB_PASSWORD=${{Postgres.PGPASSWORD}}
   N8N_AUTO_PUBLISH=true
   N8N_ENCRYPTION_KEY=
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   GEMINI_API_KEY=
   FMP_API_KEY=
   BRIEF_SECRET=
   ```

   - `N8N_ENCRYPTION_KEY` is new: a long random text that locks the credentials n8n saves. Make it once and never change it, for example in PowerShell: `$b=[byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`
   - `BRIEF_SECRET`: the one from your PC, or a new long random text. The Vercel dashboard needs the same value.
   - Add a line only for a key you have: `OPENAI_API_KEY=…`, `CHART_IMG_API_KEY=…` (the new chart-img key), `GEMINI_MODEL=…`.
5. When the deploy is green, open `https://<your domain>/` and create the owner account. The service's **Deploy Logs** show the setup: `published "SM-01 …"` and so on, or why a workflow waits.
6. Stop n8n on your PC: close its window, and if you set it to start at logon, run `powershell -NoProfile -ExecutionPolicy Bypass -File windows\start-n8n.ps1 -UnregisterAtLogon`. Two n8n with the same workflows would send every brief twice.

The `${{Postgres.…}}` values link to the database. n8n's address (`N8N_WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`) and `N8N_PROXY_HOPS=1` come from the domain of step 3 by themselves ([docker/entrypoint.sh](docker/entrypoint.sh)); a value you set by hand wins. `PORT=5678` tells Railway which port n8n listens on (its health check uses `PORT`). No volume is needed: everything n8n keeps is in Postgres, and the key is in `N8N_ENCRYPTION_KEY`. Railway stopped reading `railway.json` for new services (it was replaced by its "Infrastructure as Code"), so this repo has none and the health check is the setting of step 3. Every push to `main` deploys again.

**When a push changes the workflow files** (`workflows/*.json`): the redeploy alone keeps n8n's copies. Add the variable `SM_REIMPORT_WORKFLOWS=true`, let it deploy, check the Deploy Logs for `re-imported over the copies` and `published "SM-…"`, then delete the variable (it deploys once more, with nothing re-imported). Edits you made in the n8n editor to those workflows are replaced; what they remember (X mirror, closes) is kept.

## Keys

The setup reads these at every start. A key you set is always written into its n8n credential. A key you leave empty becomes a credential holding `REPLACE_ME` (created once); then fill it in n8n → Credentials instead.

| Variable | n8n credential | Needed by |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot | SM-01, SM-02, SM-03, WF-11.2 (create the bot with @BotFather) |
| `TELEGRAM_CHAT_ID` | (written into the workflows) | where the briefs go: your chat id (message @userinfobot), a group or channel id like `-100…`, or `@yourchannel`. WF-11.2 answers only this chat and needs the number. |
| `GEMINI_API_KEY` | Google Gemini | the AI parts, on Gemini (free key at aistudio.google.com/apikey). See "AI: Gemini or OpenAI" below. |
| `OPENAI_API_KEY` | OpenAI | the AI parts, on OpenAI (gpt-4o-mini) |
| `FMP_API_KEY` | FMP API key | SM-01 (free key at financialmodelingprep.com) |
| `BRIEF_SECRET` | Market brief secret | SM-04, same value as `BRIEF_SECRET` on Vercel (any long random text) |
| `CHART_IMG_API_KEY` | chart-img API key | WF-11.1. The old key was saved inside your WF-11.1 file, so create a new one at chart-img.com. |

X posts need no key and no account (see below).

### AI: Gemini or OpenAI

The AI writes the short paragraph of each brief (SM-01, SM-02, SM-03), rates the headlines and X posts, says in one sentence why the 🌙 share of a market is worth a look, reads the chart in WF-11.1 and runs the Telegram assistant (WF-11.2). One key is enough:

- **No AI key**: the briefs are still published and sent, without their AI paragraph; the headlines and posts are rated by keywords. WF-11.1 and WF-11.2 wait for a key.
- **Only `GEMINI_API_KEY`**: the setup switches the AI nodes to n8n's own Google Gemini nodes, with the model `gemini-3.1-flash-lite` (on Google's free tier). `GEMINI_MODEL=gemini-2.5-flash-lite` (or any other Gemini model id) changes it. Only those nodes change, in the files it imports and in the copies already in n8n. Without `GEMINI_MODEL`, a model you picked in the editor is kept.
- **Only `OPENAI_API_KEY`**, or both keys: OpenAI (gpt-4o-mini), as in the files. With both keys, `AI_PROVIDER=gemini` picks Gemini. Going back to OpenAI gives the AI nodes back exactly as they are in the files.

The setup's log says which one it uses, for example `AI: Google Gemini, default model gemini-3.1-flash-lite`.

Setup rules (full detail at the top of [tools/first-run-setup.mjs](tools/first-run-setup.mjs)):

- A workflow file is imported only when n8n doesn't have it yet, so your edits in the editor are kept. `SM_REIMPORT_WORKFLOWS=true` for one start re-imports the files over your copies (do it once after an update of the files, then set it back to `false`). What the workflows remember (the X mirror that answered, the closes behind the trend) is kept.
- `TELEGRAM_CHAT_ID` is written into the workflows at import, and also later while a workflow still holds the placeholder.
- With `N8N_AUTO_PUBLISH=true` (the default), each workflow is published as soon as it can run: its keys are real (not REPLACE_ME; the briefs don't wait for the AI key), it has the chat id, the workflows it calls are published, and for WF-11.2 `N8N_WEBHOOK_URL` is https. The log says why a workflow waits, for example `not published "SM-01 …": missing key: FMP API key`. With `false` you publish in the editor yourself.
- To get rid of a workflow, archive it in n8n. A workflow you delete is imported again on the next start.

## 🌙 picks, mood, headlines and X posts

**The 🌙 screen.** US picks (SM-01): debt and cash each under 30 % of market cap and interest income under 5 % of revenue, from the latest annual statements, and no excluded business. African markets (SM-02): business activity only, because the exchanges publish no balance sheets: banks and other interest-based finance (non-interest banks such as Jaiz Bank pass), insurance, alcohol (brewers), tobacco, gambling, hotels and leasing are left out; debt is not checked. The NGX feed names companies by ticker only, so brewers and others are caught by their tickers. `screenExclude` in SM-02 → Config leaves more tickers out.

**One share to look at per market.** Among the 🌙 shares that traded today and did not fall, with at least the median value traded of those shares (BVMAC's bulletin gives no value, so no volume test there): the best score, where score = 0.6 × the trend over the last 5 sessions + 0.4 × today's change. SM-02 keeps the closes of the 🌙 shares for 10 sessions in the workflow's own memory (n8n "static data"), so the trend appears from the third run on; until then the score is today's change. None qualifies: the brief says "none today".

**Headlines.** Google News, one search per market (`ngxNewsQuery`, `brvmNewsQuery` in French, `bvmacNewsQuery` in French), the last 72 hours (`newsHours`), duplicates and site names cleaned up.

**X posts, without an account.** They are read from a Nitter mirror, a site that shows public X posts as RSS: `xMirrors` in the Config of SM-02 and SM-03, default `nitter.kareem.one`, the one public mirror that answered searches on 7 Nov 2026. One search per market (`…XQuery`), one search a second, a few per run, with an honest User-Agent and within the mirror's robots.txt. A mirror that does not answer is named in the brief and the next run uses the next mirror in the list. Mirrors are run by volunteers and come and go (nitter.net closed in 2026 after legal letters from X): when X stays silent, add another mirror (list: github.com/zedeus/nitter/wiki/Instances). `xMirrors` empty or `off` turns X off.

**Mood and dots.** Each headline and post gets 🟢 good, 🔴 bad or ⚪ neutral news: from the AI when there is a key (it reads them in context), otherwise from English and French keywords. The mood of a market is the share of good minus the share of bad: 🟢 positive from +25 points, 🔴 negative from −25, 🟡 mixed in between, ⚪ neutral when nothing is good or bad.

## Check the live sources

`windows\check-sources.cmd` fetches the NGX price list, the BRVM share table, the latest BVMAC bulletin, the headlines of each market, the X posts and the Google News search for the refinery IPO, then runs them through the code of SM-02 and SM-03 with n8n's own PDF and RSS readers. It uses each node's own timeout and retries, as n8n does: a source set to retry is tried up to 3 times, 5 s apart, and the timeout counts the time without any data (a slow download that keeps coming is not cut off). It prints one line per source (`ok`, or `FAILED` with the reason) and both briefs as Telegram would show them, without the AI text. It needs n8n installed, but no keys, and sends nothing.

- Elsewhere: `node tools/check-sources.mjs`; in Docker: `docker compose exec n8n node /opt/stock-market/tools/check-sources.mjs`.
- Exit code 0: every source answered and was read. 1: the line marked `FAILED` says which site and why (down, or its layout changed). `X posts FAILED` alone means the market data is fine and the briefs go out without X posts.
- `windows\check-sources.cmd` saves what it printed (`check-sources.txt`) and what each site returned in `live-check\latest`, to see what changed or to refresh `tests/fixtures`. Elsewhere add `--save <folder>`.

Run it when a brief says "Source problems today".

## Vercel dashboard

Folder [vercel/](vercel/): `public/index.html` (the dashboard: the US picks with a 52-week range bar, per African market the 🌙 share to look at, mood, headlines, X posts and prices with a small trend line, and the Dangote watch: refinery IPO news, X posts and the Dangote shares), `api/brief.js` (proxy to SM-04, cached 6 hours on Vercel's CDN, so the 250 FMP calls a day are safe) and `api/health-cron.js` (daily check that n8n is up, Telegram alert when it isn't). The dashboard needs n8n at a public https address, so deploy n8n first (Railway, [C](#c-railway-always-on-https)).

1. [vercel.com/new](https://vercel.com/new) → import `MistaIA/wise-stock` → **Root Directory** `vercel` → Framework Preset **Other**, no build command.
2. **Environment Variables**, before you click **Deploy** ([vercel/.env.example](vercel/.env.example)):
   - `N8N_BASE_URL`: n8n's address, `https://<your domain>/` (the Railway domain of step C3)
   - `BRIEF_SECRET`: the same value as `BRIEF_SECRET` on Railway
   - `CRON_SECRET`: another long random text, for the daily check
   - optional, for the "n8n is down" alert: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, as on Railway
3. **Deploy**, then open `https://<project>.vercel.app`. When the briefs are not cached yet, n8n prepares them first (both briefs, live sources): allow a minute or two. Then Vercel serves them from its cache for 6 hours.

A variable changed later only counts after a redeploy (Deployments → ⋯ → Redeploy). `vercel.json` turns on Fluid compute, so `api/brief.js` may run 300 s (the Hobby maximum) and waits up to 280 s for n8n. The daily check runs between 06:00 and 06:59 UTC (07:00 in Lagos; the Hobby plan allows one cron a day, within the hour). Errors are never cached and say what to fix (wrong secret, SM-04 not published, n8n not answering). From your PC instead: `vercel deploy --prod` in the `vercel` folder.

## Templates

[templates/](templates/README.md) holds the index of the 340 "Crypto Trading & Stock Market" templates you pointed to, the 7 this project learned from, and `fetch-templates.mjs`, which fetches templates with defuddle (with retries and resume for an unstable connection).

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `node tests/run-tests.mjs` | 42 checks: the Code-node logic against samples made from the live NGX, BRVM, BVMAC, FMP and RSS answers of 6 Nov 2026 (the BOC PDF is a look-alike with that day's rows), the 🌙 screen and pick, headlines and X posts, mirror rotation, mood, the Telegram HTML, the setup's plan and publish rules, the Gemini switch, the wording | Node 22+ |
| `N8N_NODE_MODULES=<folder>/node_modules node tests/validate-workflows.mjs` | every node type, version and parameter exists in n8n 2.46.6, in the files and in their Gemini versions | `npm i n8n@2.46.6 --ignore-scripts` in that folder |
| `node tests/vercel-api.test.mjs` | the Vercel functions and vercel.json (9 checks, fake fetch) | Node 18+ |
| `node tests/dashboard.test.mjs` | the dashboard in a real browser against a fake brief: text with `&` `'` `<` `>` shows as typed (no `&amp;`), nothing from the data runs as HTML, range bars, trend lines, Dangote section, no sideways scroll on a phone. `node tests/dashboard.test.mjs brief.json --shot=page.png` renders a saved brief instead (the e2e test saves one in the temp folder) | Node 18+ and Playwright with Chromium |
| `node tests/fetch-templates.test.mjs` | the defuddle template fetcher (7 checks, local server) | registry.npmjs.org once |
| `N8N_PACKAGE=<folder>/node_modules/n8n node tests/check-sources.test.mjs` | the live-source check (9 checks, local server, n8n's PDF and RSS readers, retries, X mirrors) | an n8n install |
| `node tests/e2e/run-setup-test.mjs` | the setup against the real n8n CLI over 9 starts, including the switch to Gemini and back | Docker, `docker build -t stock-market-n8n:test .` |
| `node tests/e2e/run-docker-e2e.mjs` | real n8n + Postgres 17 + mock services: import, publish, SM-04 webhook, the three briefs (the dashboard data incl. the closes behind the trend lines), a mirror that is down then the next one (remembered in Postgres, also after a restart), scheduled SM-03, the bot lock on a Railway-style start (only `RAILWAY_PUBLIC_DOMAIN`, no `N8N_WEBHOOK_URL`). `E2E_AI=gemini` runs it on Gemini (and the bot reads a chart through WF-11.1), `E2E_AI=none` with no AI key. | the same |
| [tests/windows/](tests/windows/README.md) | the Windows install (56 checks) and start scripts (20 checks, with a real n8n start) | PowerShell 7 |

## Troubleshooting

| You see | Meaning |
|---|---|
| `address '::' is not available` or n8n not reachable in Docker | The host has no IPv6. Set `N8N_LISTEN_ADDRESS=0.0.0.0`. |
| `Mismatching encryption keys` | `N8N_ENCRYPTION_KEY` differs from the key n8n created first. Remove it (Windows) or set the original one. |
| `not published "…": missing key: …` | Fill that key in your env file or in n8n → Credentials; the next start publishes it. |
| `Telegram Trigger needs N8N_WEBHOOK_URL=https://…` | WF-11.2 waits until n8n has a public https address. |
| Railway: n8n can't reach the database (`ECONNREFUSED … 5432`, `ENOTFOUND`) | The `${{Postgres.…}}` variables don't point at the database: its service must be named `Postgres`, or change `Postgres` in them to its name. |
| Railway: requests to Telegram, FMP or the market sites fail on a new account | Railway's limited trial restricts outbound traffic. Verify the account at railway.com/verify (it uses your GitHub account) or take the Hobby plan. |
| The dashboard says `n8n did not answer` or `HTTP 404` | n8n is down, `N8N_BASE_URL` is wrong, or SM-04 is not published (its Railway log line says why). Fix it, then reload: errors are not cached. |
| The bot does not answer | It answers only `TELEGRAM_CHAT_ID`. With `@yourchannel` there, put your numeric chat id in WF-11.2 → Telegram Trigger → Restrict to Chat IDs (comma-separated for several). |
| `AMD: not in your FMP plan` in the US picks | The free FMP plan covers only part of the US market; that ticker is skipped. |
| "Source problems today" in the Africa brief | That exchange's site did not answer or changed its layout; the other markets still go out. `windows\check-sources.cmd` shows which one and why. |
| `X posts: no answer from …` | The Nitter mirror was down or showed a bot check. The next run tries the next mirror in `xMirrors`; with one mirror, add another (see above). |
| `🌙 To look at` shows no "over N sessions" | The trend needs 3 sessions in SM-02's memory: it appears from the third run on. Runs started by hand in the editor are not remembered (n8n keeps static data only for scheduled, webhook and sub-workflow runs). |
| Many `npm warn ERESOLVE overriding peer dependency` and `npm warn deprecated …` lines during the Windows install | Normal for n8n's npm install: warnings, not errors. Let it run until `n8n 2.46.6 installed`; an error that stops it is in the last lines. |
| `n8n runs on the Node.js in …, not on its own copy` when starting on Windows | n8n was installed by an earlier version of `install-n8n.ps1` on a Node 24 from PATH (nvm, for example). Run `windows\install-n8n.cmd` once more: it moves n8n to its own Node 24. |
| `Python 3 is missing`, `standardFontDataUrl`, `api.n8n.io ENOTFOUND`, deprecation notices | Harmless n8n log lines. |

## Data sources

| Market | Source | Note |
|---|---|---|
| NGX | `doclib.ngxgroup.com` price list JSON | the feed behind NGX's own price list page; unofficial, may change |
| BRVM | brvm.org share price table (HTML) | parsed from the page |
| BVMAC | official bulletin (BOC, PDF) from bvm-ac.org | the PDF text is checked against the ±10 % daily limit, so a misread price is dropped instead of reported |
| US stocks | Financial Modeling Prep `stable` API | profile, balance sheet, income statement |
| Headlines | Google News RSS | one search per market, and the Dangote search |
| X posts | a Nitter mirror's search RSS | public posts, no account; mirrors come and go |

## Project files

```
workflows/            the 6 workflow files n8n imports
src/code/             the Code-node JavaScript (tested by tests/run-tests.mjs); lib-*.js are pasted into the others
src/original/         your WF-11 exports, as received
tools/                build-workflows.mjs, upgrade-wf11.mjs, code-files.mjs, first-run-setup.mjs, check-sources.mjs
Dockerfile, docker/, docker-compose*.yml, .env.example
windows/              install-n8n.cmd/.ps1, start-n8n.cmd/.ps1, check-sources.cmd, n8n.env.example
vercel/               dashboard, api/brief.js, api/health-cron.js, vercel.json
templates/            template index, the 7 selected templates, fetch-templates.mjs (defuddle)
tests/                unit, workflow validation, Vercel, template fetcher, source check, Docker end-to-end, Windows
JOURNAL.md            work log for the next agent (newest on top)
```
