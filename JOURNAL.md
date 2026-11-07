# JOURNAL: Stock & Market n8n

Workflow rule from MistaIA: every agent (or person) who works on this project reads this file first and, before stopping, adds a dated entry **at the top**: what was done, which files, how it was tested, open issues, next step. Any other agent must be able to pick up from it.

Project folder: `2026/Startover/stock-market-n8n/` in the project files. Code: https://github.com/MistaIA/wise-stock (public). Trello board: https://trello.com/b/dAKYwdEh. Start with [README.md](README.md) for how everything fits together.

---

## 2026-11-07 · Code on GitHub: MistaIA/wise-stock

**Asked by MistaIA** (20:59 UTC): "Link to its github account: https://github.com/MistaIA/wise-stock.git".

- The repository is **public** and was empty (default branch `main`). The project goes in as the first commit on `main`, the same 86 files as the project files folder `2026/Startover/stock-market-n8n/`. The repository is saved in the project's settings, so later threads have it.
- Checked before committing: no key or token in any file (provider key patterns, `apikey=` values, long random strings; the chart-img key that was in the shared WF-11.1 had already been removed from `src/original/`; the long ids in two templates are Google Sheets ids from public n8n templates). `.gitignore` keeps `windows/n8n.env`, `.env` files and `live-check/` out. The Windows username was taken out of the IA folder path below.
- Pushing from the cloud needs the Claude GitHub App on the repository (or GitHub connected at claude.ai/connect-github); reading worked without it.

**Next:** from now on, change the code in the repository and keep the project files folder and IA in step with it (or move to the repository alone, if MistaIA prefers).

---

## 2026-11-07 · Headlines, X posts and mood per market; one 🌙 share to look at; only the 🌙 icon shown

**Asked by MistaIA** (16:29–16:40 UTC): "is it good?" about the first `windows\check-sources.cmd` run on IA (NGX, BRVM, News, Dangote ok; BVMAC "BOC PDF: no answer within 60 s"). Then: sentiment from X (Twitter) and headline updates, and for each market one share to look at that passes the screen, marked only with the moon icon and with no religious word anywhere; "if BVMAC is failling it is ok, until it works". Then: "We do not need account since there are twitter mirrors, like nitter".

**Answer to "is it good?":** yes. On IA the BVMAC index page loaded but the bulletin PDF did not arrive within 60 s (a slow site or connection; the cloud can't reach bvm-ac.org to compare). n8n itself tries each source 3 times, and check-sources now does the same. MistaIA's saved output also showed two real problems, fixed below (a brewer passing the screen, shares that did not trade counted as unchanged).

### Done

- **Headlines per market (SM-02).** New Code node "Headline feeds" (`src/code/headline-feeds.js`): one Google News RSS search per Config key ending in `NewsQuery` (`ngxNewsQuery`, `brvmNewsQuery`, `bvmacNewsQuery`), fetched by "Fetch headlines" (HTTP, retry on fail). Last `newsHours` (72), same story from several sites shown once, newest first, 3 per market. The site name is split off the title, also when a site adds its own separator ("… IPO | - Site").
- **X posts without an account (SM-02 and SM-03), through Nitter mirrors.** "X feed list" (`src/code/x-feed-list.js`) builds one search per Config key ending in `XQuery` on the first mirror of Config → `xMirrors` (default `nitter.kareem.one`; empty or `off` turns X off); IF "X on?" → "Fetch X posts" (one request per 1.1 s, retry on fail). The mirror that answered is remembered in the workflow's static data (`xMirror`); when it fails, the brief says so under "Source problems today" and the next run tries the next mirror in the list. A mirror that answers with a web page (bot check) counts as not answering. Honest User-Agent `StockMarketBrief/1.0 (n8n; personal market digest)` and an RSS Accept header; never a browser User-Agent, no bot check is passed. Mirror study (7 Nov): the Nitter repo is archived (11 Sep 2026), nitter.net is offline, poast/tiekoetter/catsarch disallow our fetcher in robots.txt; only nitter.kareem.one served search RSS. The paid X API was not used.
- **Mood.** Each headline and post gets 🟢/🔴/⚪: the AI's rating per item (JSON `sentiment`, ids h1…, x1…) when an AI key is set, otherwise English and French keywords (`FEEDS.rate`). Mood line per market and for the Dangote watch: (good − bad)/n ≥ 0.25 positive, ≤ −0.25 negative, nothing good or bad neutral, otherwise mixed.
- **🌙 To look at, one share per market.** Among the 🌙 shares that traded today and did not fall, with at least the median value traded of those shares (no value test for BVMAC, its bulletin has no value column): best score = 0.6 × trend over the last 5 sessions + 0.4 × today's change; today's change alone until 3 closes are known. SM-02 keeps the closes of the 🌙 shares for 10 sessions in its static data (`history`). The AI adds one line `why` per market. "none today" when nothing qualifies.
- **Screen fixes, found in MistaIA's live data (NGX session of 6 Nov).** The NGX feed names companies by ticker only, so the name rules missed brewers: CHAMPION (Champion Breweries, +10%) was shown as passing and would have been the NGX pick. New ticker list `NGX_FAIL` in `src/code/africa-build.js` (NB, INTBREW, CHAMPION, GOLDBREW, GUINNESS, IKEJAHOTEL, TRANSCOHOT, CUSTODIAN, VFDGROUP, CILEASING, NIDF), the "Financial services" sector fails, NGX's Non-Interest board passes, Config → `screenExclude` adds tickers. Breadth now counts shares that did not trade apart ("1 not traded"): the live brief had shown 75 "unchanged" out of 146, most of them without a trade.
- **Only 🌙 is shown.** The two old icons are gone (🌙 marks a share that passes, nothing marks the others); no religious word in the Telegram texts, the AI prompts (models are told never to mention religion), the Telegram assistant (its SM-01 tool is now `stockPicks`), SM-04's JSON (key `picks`, node "Run stock picks"), the dashboard, workflow names and notes, README, JOURNAL and file names (SM-01's Code files are now `src/code/picks-{universe,screen,compose}.js`, its workflow file `workflows/01-us-stock-picks.json`). Only the workflow id `smHalalPicks0001` stays, so the copy already in n8n is updated, not duplicated. `tests/run-tests.mjs` checks file names and texts and allows only that id.
- **SM-03 Dangote watch:** X posts block (`dangoteXQuery`), mood line, AI `sentiment`.
- **SM-04 + Vercel dashboard** (`vercel/public/index.html`): per market a "To look at" card (trend, value traded, AI reason), mood, headlines, X posts or the X problem; links only for http(s).
- **OpenAI JSON mode bug, found by the Docker run before it reached anyone.** With `response_format: json_object`, n8n's Basic LLM Chain (v1.6+) returns the parsed object as the item, with no `text` field, so SM-02's insights and SM-03's summary came out empty on OpenAI (Gemini answers still come as `text`). New `TG.aiAnswer()` in `src/code/lib-compose.js` reads both shapes; unit tests for both.
- **Shared code** pasted into the Code nodes by `tools/code-files.mjs` (a line `// #include lib-feeds` or `lib-compose`): `src/code/lib-feeds.js` (RSS parsing, headlines, posts, keyword rating, X state) and `src/code/lib-compose.js` (Telegram HTML, AI answer, mood, message split). "60 min ago" now reads "1 h ago".
- **check-sources** (`tools/check-sources.mjs`, `windows\check-sources.cmd`): retries like n8n (3 tries; the 60 s timeout counts from the last byte received, like n8n's socket timeout; "(tried 3 times)"), new lines Headlines, X posts and X Dangote, saves `news-<market>.xml` and `x-<market>.xml`, `--fast` for tests. When only X fails, the verdict says the market data is fine and the briefs go out without X posts.
- **Checked in n8n's code and in a real n8n:** static data is saved after scheduled, webhook and sub-workflow runs, not after a run started by hand in the editor; `import:workflow` of our files (which carry no static data) keeps it (CLI on Postgres: `xMirror` and `history` unchanged after a re-import). The README said a re-import clears it: corrected.

### How it was tested (7 Nov, cloud container)

| Test | Result |
|---|---|
| `node tests/run-tests.mjs` (new: pick and mood rules, AI answer in both shapes, X and headline blocks, wording and file names) | 42/42 |
| `node tests/check-sources.test.mjs` (new: news and X requests, X spacing ≥ 1 s with the honest User-Agent, mirror down, bot check page, a source that answers on the 3rd try) | 9/9 |
| `node tests/vercel-api.test.mjs` | 7/7 |
| `node tests/validate-workflows.mjs` | 11/11 |
| `node tests/e2e/run-docker-e2e.mjs` (OpenAI): first mirror down → problem line and the next mirror saved in Postgres; second run shows the X posts; MTNN and SNTS picked, BVMAC "none today"; mood with the AI's ratings; SM-03 on its schedule, then the second mirror; restart keeps the mirror | pass |
| `E2E_AI=gemini node tests/e2e/run-docker-e2e.mjs` (the AI wraps its JSON in a code fence, as Gemini does; the bot reads a chart through WF-11.1) | pass |
| `E2E_AI=none node tests/e2e/run-docker-e2e.mjs` (keyword ratings, no 🧠 block, briefs still go out) | pass |
| `node tests/e2e/run-setup-test.mjs` (real n8n CLI, 9 starts, with the renamed SM-01 file) | pass |
| `tests/windows/start-n8n.tests.ps1` (real start through start-n8n.ps1) | 20/20 |

### Open issues

- Nitter is volunteer-run: nitter.kareem.one may stop or start refusing; then the briefs go out without X posts and say so. Other mirrors can be added to Config → `xMirrors` (only ones whose robots.txt allows it).
- The trend needs 3 scheduled runs of SM-02 (3 weekdays) before it counts; manual runs are not remembered.
- BVMAC's PDF is slow from IA; the brief goes out without BVMAC when it fails (MistaIA: fine until it works).
- Gemini is still tested only against a stand-in of Google's API.
- In n8n's editor URL SM-01's id still reads `smHalalPicks0001`; changing it would make the setup import SM-01 as a new workflow (old one to archive by hand).
- The Trello board name still contains an old word; the Trello tool can't rename boards: MistaIA renames it.

### Next steps

1. Done by the agent (7 Nov, ~20:40 UTC): the files on IA were updated. The PC copy was first checked against the last sync (all 81 files unchanged), the 4 renamed files were moved with `mv`, 36 files were written with `device_commit_files` from the project files, and all files were hash-checked again. `windows\n8n.env` was not touched.
2. MistaIA: set `SM_REIMPORT_WORKFLOWS=true` in `windows\n8n.env` for one start of `windows\start-n8n.cmd` (only needed if n8n has already run once), then back to `false`.
3. Run `windows\check-sources.cmd` again: it now shows Headlines, X posts and X Dangote lines.
4. Then the next steps of the entries below (owner account, new chart-img key, Railway + Vercel).

### Trello

Reworded with 🌙 and no religious word: product vision, sprint cadence (epic `[SCREEN]`), `[WF] US stock picks`, the Africa brief card, the bot card (`/picks`), the two `[SCREEN]` backlog cards and two icebox cards. New card in 👀 Review / QA: "[WF] Headlines, X posts, mood and one 🌙 share to look at per market · 5 pts". The board's own name still has an old word in it; the Trello tool can only create boards, so MistaIA renames it.

---

## 2026-11-07 · Briefs without an AI key; Gemini instead of OpenAI

**Asked by MistaIA** (15:15 UTC): "What if I dont have the OPEN API yet? Will it still work, or does work if I give gemini 2.5 flash lite?" (with questions on BRIEF_SECRET/Vercel and the chart-img limit, answered in the thread: BRIEF_SECRET is any long random text set on both sides, no Vercel project needed before n8n runs; chart-img is only called when someone asks the Telegram assistant for a chart, never on a page load, and /api/brief is cached 6 h by Vercel's CDN).

### Done

- **The briefs no longer need an AI key.** `requirements()` in `tools/first-run-setup.mjs` marks a credential as optional when it is used only by AI model sub-nodes whose chains carry on after an error (`onError: continueRegularOutput`): the AI paragraph of SM-01, SM-02 and SM-03. Such a key no longer blocks publishing; the log says `published "SM-01 …" (no AI paragraph yet: no OpenAI key)` and once `no AI key yet: …`. Without a key the LLM call fails (401/400), the chain continues, and the compose code leaves the 🧠 block out (it already did). WF-11.1 and WF-11.2 still wait for a key.
- **Gemini.** New `aiChoice()` and `withAiProvider()` in the same file (the Dockerfile only copies that file):
  - Provider: `AI_PROVIDER` (openai | gemini | google) wins; otherwise Gemini when `GEMINI_API_KEY` is set and `OPENAI_API_KEY` is not; otherwise OpenAI (the files). Model: `GEMINI_MODEL` (with or without `models/`), default **gemini-3.1-flash-lite**. Why not 3.5 Flash-Lite (named in the thread earlier): Google's pricing page (June 2026) lists a free tier for 3.1 Flash-Lite and 2.5 Flash-Lite; 3.5 Flash-Lite isn't on it, so its free tier could not be confirmed. gemini-2.5-flash-lite is "served until further notice" (models page, 28 Oct 2026).
  - Only the AI model nodes that exist in the workflow file (matched by node id) are switched, in the files the setup imports and in the copies already in n8n (new plan action `ai-model`, unpublish → import → publish again, like `chat-id`). Nothing else in a workflow changes; AI nodes a user adds stay as they are.
  - OpenAI → Gemini: `lmChatOpenAi` → `lmChatGoogleGemini` v1.2 (`modelName: models/<id>`; options `{}` for Gemini 3+, because Google asks to keep their default temperature 1.0 (lower "may lead to … looping"); the file's temperature 0.2 for Gemini 1.x/2.x; no token cap, which on thinking models would also count the thinking). WF-11.1's `openAi` image analyze → `googleGemini` v1.2 image analyze (binary input `data`, simplify on; n8n uploads the image to Gemini's Files API), and the `response` expression of "Edit Fields1" becomes `(($('Gemini').item.json.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('')`. Nodes are renamed (OpenAI model → Gemini model, OpenAI Chat Model → Gemini Chat Model, OpenAI → Gemini) with connections, `$('…')`/`$node[…]`/`$items(…)` references and pinData, unless the name is taken or the user renamed the node. Credential "Google Gemini" (`googlePalmApi`, id `smCredGemini0001`) from `GEMINI_API_KEY`; `GEMINI_API_BASE_URL` only for tests.
  - Gemini → OpenAI (OpenAI key back, or `AI_PROVIDER=openai`) restores the file's nodes exactly. A node already on Gemini keeps its model unless `GEMINI_MODEL` is set, so a model picked in the editor survives restarts.
  - Checked in the n8n 2.46.6 sources before writing it: the workflow tools of WF-11.2 have an `input` string parameter, so Gemini accepts their declarations; @langchain/google-genai 2.1.24 sends Gemini 3's function-call thought signatures back; the chain's StringOutputParser reads Gemini's text parts.
- **Env examples** (`windows/n8n.env.example`, `.env.example`): `GEMINI_API_KEY`, `# GEMINI_MODEL=`, `# AI_PROVIDER=`. MistaIA's own `windows\n8n.env` was copied from the old example, so the `GEMINI_API_KEY=` line has to be added there by hand (start-n8n loads any KEY=VALUE line). No agent reads or writes that file.
- **README**: Keys table, new "AI: Gemini or OpenAI" section, setup rules, tests table.

### How it was tested (7 Nov, cloud container)

| Test | Result |
|---|---|
| `node tests/run-tests.mjs`, 3 new: the AI choice; the Gemini switch touches only the AI model nodes (every other node deep-equal to the file, connections and `$('…')` references valid) and switching back gives the file's JSON again; the briefs publish without an AI key while WF-11.1/11.2 wait | 30/30 |
| `node tests/validate-workflows.mjs`, now also the Gemini version of each workflow against n8n 2.46.6's node definitions | 11/11 (6 files, 5 Gemini versions). A deliberately wrong Gemini parameter (`maxTokens`, `inputType: base64`) is reported. |
| `node tests/e2e/run-setup-test.mjs`, real n8n CLI, 9 starts (4 new): the published copies switch to Gemini and are published again, SM-04 untouched, the OpenAI credential left alone; `GEMINI_MODEL=gemini-2.5-flash-lite` sets the model and temperature 0.2; without it the model in n8n is kept; with the OpenAI key back, WF-11.1 in n8n has the file's nodes and connections again | pass |
| `node tests/e2e/run-docker-e2e.mjs` (OpenAI, as before) | pass |
| `E2E_AI=gemini node tests/e2e/run-docker-e2e.mjs`: the briefs' AI paragraphs come from n8n's Gemini chat model (request has no temperature and no token cap); the bot answers on Gemini; "chart-test" makes the mock Gemini call getChart, and WF-11.1 runs for real: chart-img storage call with the key, PNG download, upload to the Files API, generateContent on the uploaded image, the thought signature sent back with the tool result, the answer in Telegram | pass |
| `E2E_AI=none node tests/e2e/run-docker-e2e.mjs`: SM-01..03 published "(no AI paragraph yet: no OpenAI key)"; the AI call is refused (401, `Bearer REPLACE_ME`) and both briefs and the scheduled SM-03 go out without the 🧠 block; WF-11.1 and WF-11.2 stay unpublished | pass |
| `tests/windows/start-n8n.tests.ps1` (real start through start-n8n.ps1, which runs the new setup) | 20/20 |

### Open issues

- The Gemini path is tested against a local stand-in of Google's API (same URLs, auth and answer shapes as n8n's code expects), not against Google itself: there is no Gemini key in the cloud (MistaIA's key stays on IA). The first start on IA with the key is the live check.
- WF-11.1's OpenAI image path is still only checked statically (the e2e reads a chart on Gemini only).

### Next steps

1. MistaIA: add `GEMINI_API_KEY=<key from aistudio.google.com/apikey>` to `windows\n8n.env`, then `windows\check-sources.cmd` and `windows\start-n8n.cmd`. The start log should show `AI: Google Gemini, default model gemini-3.1-flash-lite` and `credential "Google Gemini": set from GEMINI_API_KEY`.
2. Then the next steps of the entries below (live-check results, owner account, new chart-img key, Railway + Vercel).

---

## 2026-11-07 · n8n gets its own Node on Windows; first real install running on IA

**Asked by MistaIA:** "is it using nvm to install node ?" (08:41 UTC), while `windows\install-n8n.cmd` was running on IA for the first time.

### Done

- **`install-n8n.ps1` now always installs n8n on its own Node 24** in `%LOCALAPPDATA%\n8n-sm\node`. Before, it reused a Node 24 x64 found on PATH. With nvm-windows that PATH entry is a link that follows `nvm use`, and the nodejs.org installer replaces it on an upgrade, so n8n (whose native modules are built for Node 24) would stop starting after a switch or an upgrade. A node.exe on PATH is now only named in the log ("is not used and not changed"). `Test-Installed` treats an install.json whose `nodeExe` is not the own Node as not installed, so running the installer again moves an install made by the old script onto its own Node (a 30 MB Node zip; npm's cache makes the rest quick).
- **`start-n8n.ps1` points it out**: when install.json names a Node outside the install folder, it prints "n8n runs on the Node.js in …, not on its own copy. Run windows\install-n8n.cmd once more…" and starts anyway.
- **README**: Windows step 1, two troubleshooting rows (the npm warnings MistaIA saw, the note above), test counts. The answer to MistaIA: no nvm; n8n keeps its own Node and never touches theirs.

### How it was tested (7 Nov, cloud container, PowerShell 7.4 in Docker)

| Test | Result |
|---|---|
| `tests/windows/install-n8n.tests.ps1`, 6 new checks: a usable Node 24 on PATH is not used and is named in the log; an install.json pointing at another Node is redone; install.json then names the own Node | 56/56 (4 of the new checks fail on the old script) |
| `tests/windows/start-n8n.tests.ps1`, real n8n start, 2 new checks: the note shows for a Node outside the install folder, not for the own one | 20/20 |

### State on IA

- MistaIA started `windows\install-n8n.cmd` at 10:41 local (08:41 UTC) with the **previous** script. npm got past resolving with only the usual `ERESOLVE overriding peer dependency` and `deprecated` warnings (pasted in the thread). Which Node it used is in the lines before `npm install`, and in `%LOCALAPPDATA%\n8n-sm\install.log` (outside this thread's folder access).
- The new scripts were copied into `...\2026\stock-market-n8n` while it ran. PowerShell had already read the old script, so the running install is not affected; a retry task would run the new one.
- 10:05 UTC: MistaIA reported the install finished. At their request this thread created `windows\n8n.env` as a plain copy of `n8n.env.example` and listed where each key comes from; MistaIA pastes the keys in (an agent never writes keys there). `check-sources` had not been run yet.

### Open issues

As in the entry below, except item 1: the Windows install is now running on IA for real (cmd.exe and Windows PowerShell 5.1).

### Next steps

1. When the install says "n8n 2.46.6 installed": run `windows\install-n8n.cmd` once more (a few seconds and "already installed" if n8n is on its own Node; otherwise it moves it there), then `windows\check-sources.cmd`. Read `live-check\latest` through folder access and fix what a real site breaks.
2. Then the next steps of the entry below (n8n.env with a new chart-img key, start-n8n, Railway + Vercel).

---

## 2026-11-07 · Live source check, two Windows fixes, install handed over to IA

**Asked by MistaIA:** the request in the entry below; this session finished it on its own ("you do not need me in the loop").

### Done

- **Live source check** `tools/check-sources.mjs`, with `windows/check-sources.cmd` (also in the Docker image as `/opt/stock-market/tools/check-sources.mjs`). It fetches NGX, BRVM, the latest BVMAC bulletin and the Google News search with the URLs and headers of the workflows' own nodes, reads the BOC PDF and the feed with n8n's own libraries (pdfjs-dist and rss-parser, resolved from n8n-nodes-base of the installed n8n), runs the Code nodes of SM-02 and SM-03, and prints one `ok`/`FAILED` line per source plus both briefs as plain text. No keys, nothing is sent. `--save <folder>` keeps what each site returned. Why: the cloud container cannot reach the exchanges' sites, so the parsers had only seen samples (see the correction below). This is the check to run on IA.
- **Fixed `templates/fetch-templates.cmd`**: it redirected to `/dev/null`, which cmd.exe cannot open, so whenever Node came from PATH it said "Node.js was not found" and stopped. Now `>nul 2>nul`. The other .cmd files had nothing similar.
- **Fixed the start check of `templates/fetch-templates.mjs`**: it compared `argv[1]` with the module's real path, so started through a junction or a symlinked folder it silently did nothing. It now compares real paths (case-insensitive on Windows), and it exits only after its output is written out.
- **check-sources keeps its findings**: it also writes what it printed to `check-sources.txt`, and `windows\check-sources.cmd` saves everything into the project's `live-check\latest` by default (ignored by git). So an agent with folder access to the project on IA can read the live answers afterwards: that access runs in a Linux sandbox with no internet of its own, so it cannot run the check itself.
- **README**: Windows step 2 runs the check, new section "Check the live sources", tests table, troubleshooting row. **Trello**: the OPS IA install card now has the real steps (Node from nodejs.org, not winget) and a done condition.

**Correction to the entry below:** the parsers were tested on samples *made from* the live answers of 6 Nov 2026: a cut-down NGX JSON and BRVM HTML with the real columns, and `boc-sample.pdf`, a look-alike built with reportlab from the real rows of BOC n°2632. None of them is a byte copy of a live answer. `check-sources --save` on IA gives real copies; they can replace the fixtures.

### How it was tested (7 Nov, cloud container)

| Test | Result |
|---|---|
| `node tests/check-sources.test.mjs` (the tool against `tests/e2e/mock-server.mjs` with the libraries of n8n 2.46.6: every source ok, headers and query strings as in the workflows, a 404, a refused connection, a BOC that is not a PDF, an index page without bulletins, usage errors) | 6/6 |
| The tool inside `n8nio/n8n:2.46.6` (pnpm layout, Node 26) and inside the rebuilt project image | ok, all five sources |
| `node tests/fetch-templates.test.mjs`, and the script started through a symlinked folder | 7/7, runs |
| `run-tests.mjs` 27/27, `validate-workflows.mjs` 6/6, `vercel-api.test.mjs` 7/7 | pass |
| `tests/e2e/run-setup-test.mjs` and `tests/e2e/run-docker-e2e.mjs` with the rebuilt image | SETUP TEST OK, E2E OK (run 11) |

### Open issues (the current list, replacing the one below)

1. **Not yet run on IA.** Windows PowerShell 5.1 and cmd.exe have not run these scripts for real; the cloud container has neither.
2. **Live sources not yet read**: `windows\check-sources.cmd` on IA answers it in a minute.
3. **Rotate the chart-img key** (the old one was saved in the original WF-11.1 file).
4. The dashboard and WF-11.2 need n8n on a public https address (Railway, or a Cloudflare tunnel to IA). Not deployed yet.
5. FMP free plan covers only part of the US market ("Without data" in SM-01).
6. Dangote refinery listing (~8 Dec 2026): SM-03 flags the new ticker; then add it to SM-02 `ngxWatchlist` and SM-03 `knownDangoteSymbols`, and update `ipoNote`. `check-sources` also prints "NEW on NGX".
7. n8n's internal task-runner mode is deprecated (still works); `docker-compose.runners.yml` is the way out.
8. A workflow deleted in n8n is imported again on the next start: archive instead.

### Next steps

1. **On IA**: the project's folder there is `%USERPROFILE%\Documents\Self Development\Self\PROJECTS\CRYPTO\2026` (MistaIA, 7 Nov), and MistaIA unpacked this project to `...\2026\stock-market-n8n` (not under `Startover` as in the project files; leave it there, because the hourly retry task of a failed install runs `windows\install-n8n.ps1` from that path). MistaIA declined Remote Control twice (its card only offers the `D:\Web-Server\...` folders where Remote Control runs) and runs `windows\install-n8n.cmd` and `windows\check-sources.cmd` by hand. This thread was given folder access to `...\CRYPTO\2026` (in the sandbox at `/sessions/<id>/mnt/2026`), so it can read `live-check\latest` afterwards and check the parsers on real data.
2. MistaIA: fill `windows\n8n.env` (new chart-img key), run `windows\start-n8n.cmd`, create the owner account, check SM-02 once in n8n → Executions.
3. Decide where n8n runs 24/7 with https (Railway recommended), then deploy `vercel/`.

---

## 2026-11-07 · First build: workflows, Docker, Windows install, Vercel, templates (thread started 2026-11-06)

**Asked by MistaIA:** set up n8n so it can be used with Vercel, reusing the shared resources (WF-11.1/WF-11.2 in `N8N-Stock-Market`, AutoFlow in `sharemarket_n8n`, the awesome-n8n-templates crypto-trading category via npm defuddle). Focus: 1–2 high-potential stocks that pass the 🌙 screen, NGX (with Dangote), BRVM and BVMAC. Install n8n with npm, retrying every hour when the internet fails. Write the Docker files. Run the project as agile on Trello. "Do not make mistakes, study first." "You do not need me in the loop."

### Done

- **Study** (Trello card STUDY): n8n cannot run on Vercel (serverless); the user's AutoFlow already uses Vercel (frontend) + Railway (backend), so n8n goes on Railway/Docker or the user's PC and Vercel hosts a dashboard. Data sources verified live on 2026-11-06: NGX `doclib.ngxgroup.com` JSON (unofficial, behind NGX's own price page), brvm.org share table (HTML), BVMAC official bulletin PDFs (`bvm-ac.org/bulletin-officiel-de-la-cote-boc/`), Google News RSS, FMP `stable` API. `afx.kwayisi.org` is stale, not used. Dangote refinery IPO: 4.1bn shares at ₦525, offer closed 27 Oct 2026, NGX trading targeted about 8 Dec 2026 (provisional, no ticker yet on 6 Nov).
- **Workflows** (`workflows/`, generated by `tools/build-workflows.mjs` and `tools/upgrade-wf11.mjs`): SM-01 US stock picks (🌙 screen of debt, cash and interest income over 10 US tickers, top 2, AI explanation), SM-02 Africa brief (NGX, BRVM, BVMAC), SM-03 Dangote watch, SM-04 brief API (webhook for Vercel, header auth), WF-11.1 and WF-11.2 upgraded (keys moved into credentials, `EXCHANGE:TICKER`, three new agent tools).
- **WF-11.2 bot locked to `TELEGRAM_CHAT_ID`** (Telegram Trigger v1.5, "Restrict to Chat IDs"; v1.1 shows the field but n8n ignores it below v1.2). Without this, anyone who found the bot could spend the OpenAI credit and the 250 FMP calls a day SM-01 needs. The setup does not publish WF-11.2 until the chat id is in.
- **Bot replies sent as escaped HTML** with only `# headings` and `**bold**` turned into `<b>`. The Telegram node defaults to legacy Markdown, and Telegram refuses a whole message whose Markdown doesn't parse (a stray `_` or `*` in AI text).
- **Start-up setup** `tools/first-run-setup.mjs` (runs in Docker before n8n, and from `windows/start-n8n.ps1`): keys from env → credentials (REPLACE_ME placeholders when missing, recognised later via a decrypted export that is deleted at once); workflows imported only when missing; chat id written in at import or later; auto-publish when a workflow can really run (real keys, chat id, callees published, https for the Telegram trigger), callees first; unpublish before `SM_REIMPORT_WORKFLOWS` (n8n refuses to import over a published workflow).
- **Docker**: `Dockerfile` (n8nio/n8n:2.46.6 + workflows + setup), `docker/entrypoint.sh`, `docker-compose.yml` (Postgres 17), optional `docker-compose.runners.yml`, `railway.json`, `.env.example`.
- **Windows** (`windows/`): `install-n8n.cmd/.ps1` installs Node 24 x64 (SHA-256 checked) + `npm install -g n8n@2.46.6 --prefix` into `%LOCALAPPDATA%\n8n-sm`; on an internet failure a hidden scheduled task retries every hour for up to 30 days, then removes itself. `start-n8n.cmd/.ps1` loads `windows\n8n.env`, runs the setup, starts n8n; `-RegisterAtLogon` for a hidden start at logon. Node 24, not 26: the Kafka client in n8n-nodes-base ships Windows prebuilds only up to Node 24 (isolated-vm has 24 and 26, sqlite3 is N-API).
- **Vercel** (`vercel/`): dashboard `public/index.html` (sanitises the Telegram HTML it shows), `api/brief.js` (proxy to SM-04, CDN cache 6 h + stale 1 day, any query string redirected so it can't bypass the cache), `api/health-cron.js` (daily 06:00 UTC, 3 tries, Telegram alert), `vercel.json`.
- **Templates** (`templates/`): `INDEX.md` (all 340 templates of the category, 32 stock + Telegram ones on top), `selected/` (the 7 the workflows learned from; template 14580 contained its author's FMP key 12 times, replaced with `YOUR_API_KEY`), `fetch-templates.mjs/.cmd` (defuddle 0.19.6 for the pages + workflow.json from raw GitHub; 4 tries per download, resume, keys replaced).
- **Docs**: `README.md` (architecture, three ways to run, keys, setup rules, Vercel, tests, troubleshooting).

### How it was tested (all on 2026-11-07, in the cloud container)

| Test | Result |
|---|---|
| `node tests/run-tests.mjs` (Code-node logic on saved NGX/BRVM/BVMAC/FMP/RSS samples, Telegram HTML, setup plan and publish rules, bot lock) | 27/27 |
| `node tests/validate-workflows.mjs` (node types, versions, parameters against n8n 2.46.6) | 6/6 workflows |
| `node tests/e2e/run-setup-test.mjs` (setup against the real n8n CLI, 5 starts) | OK |
| `node tests/e2e/run-docker-e2e.mjs` (real n8n 2.46.6 + Postgres 17 + mocks: import, publish, SM-04 webhook, both briefs, scheduled SM-03, restart, then WF-11.2 published with an https URL: update without secret → 403, stranger's chat → no reply, own chat → HTML reply) | OK (run 10) |
| `node tests/vercel-api.test.mjs` | 7/7 |
| Dashboard in Chromium (Playwright): good, hostile and n8n-down briefs, phone width | OK, no script injection, no horizontal scroll |
| `node tests/fetch-templates.test.mjs` (real defuddle CLI against a local copy shaped like the site) | 7/7; also run against pages rendered locally from the real 340 template READMEs (site layout imitated), with the real workflow.json files from GitHub |
| `tests/windows/install-n8n.tests.ps1` (PowerShell 7.4 in Docker) | 50/50 |
| `tests/windows/start-n8n.tests.ps1` (PowerShell 7.4, real n8n start) | 18/18 |

### Open issues and risks

1. **Not yet run on the user's PC "IA".** The scripts target Windows PowerShell 5.1; their logic was tested on PowerShell 7.4 (Linux, Docker). PS 5.1 pitfalls were handled by design (ASCII-only scripts, CRLF, native stderr, TLS 1.2, `-UseBasicParsing`), but only a real run proves it.
2. **Live data not checked from the cloud**: brvm.org, ngxgroup.com, bvm-ac.org and github.io are blocked by the container's proxy. The parsers are tested on samples saved on 2026-11-06. Check one real run of SM-02 on IA (n8n → Executions) and the BOC PDF of the day.
3. **Rotate the chart-img key**: the old key was saved inside the original WF-11.1 file.
4. **Dashboard and WF-11.2 need n8n on a public https address** (Railway, or a Cloudflare tunnel to IA). Neither is deployed yet. Vercel `vercel.json` follows the docs but has not been deployed yet.
5. **FMP free plan** covers only part of the US market; uncovered tickers show under "Without data" in SM-01.
6. **Dangote refinery listing (~8 Dec 2026)**: SM-03 flags a new Dangote ticker on NGX by itself; after that, add the ticker to SM-02 `ngxWatchlist` and SM-03 `knownDangoteSymbols` (Config nodes) and update `ipoNote`.
7. n8n logs that the internal task-runner mode is deprecated (still works); `docker-compose.runners.yml` is the way out. Harmless log lines: Python runner missing, pdfjs `standardFontDataUrl`, `api.n8n.io ENOTFOUND` without internet.
8. A workflow deleted in n8n is imported again on the next start: archive instead.

### Next steps

1. On IA: get this folder onto the PC, run `windows\install-n8n.cmd`, fill `windows\n8n.env`, run `windows\start-n8n.cmd`; check the setup log says SM-01..SM-04 published; trigger SM-02 once by hand and compare with brvm.org/NGX/BVMAC.
2. On IA: `templates\fetch-templates.cmd` (first live defuddle run against github.io).
3. Decide where n8n runs 24/7 with https (Railway recommended), then deploy `vercel/` with its env vars.

### Trello

Cards: STUDY, US picks, Africa, Dangote, BOT WF-11, Docker, Vercel, Windows install, DOCS, OPS IA install. Everything built and tested here is in Done; OPS IA install stays open until the run on IA.
