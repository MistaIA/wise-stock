# n8n templates

Reference material from the [awesome-n8n-templates](https://scrapernode.github.io/awesome-n8n-templates/templates/crypto-trading/) category "Crypto Trading & Stock Market" (340 templates). The start-up setup never imports anything from this folder: it imports only `../workflows`.

| Path | What it is |
|---|---|
| [INDEX.md](INDEX.md) | All 340 templates, most viewed first, with the 32 that combine stocks and Telegram at the top. |
| [selected/](selected/) | The 7 templates this project learned from: each one's README and workflow.json, copied from the project's GitHub repository at commit e4ba8fae (24 Oct 2026). |
| [fetch-templates.mjs](fetch-templates.mjs) | Fetches templates with **defuddle** (npm): the page as readable Markdown, plus the importable workflow.json. |
| `fetch-templates.cmd` | The same on Windows, with the Node that `windows\install-n8n.cmd` installed. |

Template 14580 had its author's FMP API key written into it 12 times. The copy in `selected/` has `YOUR_API_KEY` there instead, and `fetch-templates.mjs` does the same for any template it downloads. Use your own key through the n8n credential, never a key from a template.

## What the workflows took from them

Nothing is copied. The workflows in `../workflows` follow some of these patterns:

| Template | What it does | Used in this project |
|---|---|---|
| [15928](selected/15928-send-taiwan-stock-pre-market-briefings-using-twse-cnyes-openai-and-telegram/) Taiwan pre-market brief | Weekday schedule, exchange data with "no data" fallbacks, OpenAI summary, Telegram | The shape of SM-01 and SM-02: a Config node (chat id, tickers), a weekday schedule, and a source that is down never stops the brief |
| [5712](selected/5712-automated-stock-news-alerts-with-google-rss-gemini-telegram-notifications/) Stock news alerts | Google News RSS, AI summary, Telegram | SM-03 Dangote watch works the same way |
| [14580](selected/14580-generate-daily-stock-buyholdsell-signals-with-gpt-4o-gemini-fmp-sheets-and-teleg/) BUY/HOLD/SELL signals | FMP `stable` API for profiles and statements | SM-01 reads the same FMP `stable` endpoints (profile, balance sheet, income statement) for the screen ratios |
| [3202](selected/3202-stock-market-technical-analysis-with-gpt-4o-and-tradingview-for-telegram/) TradingView analysis in Telegram | Chart image + AI agent | The same family as your WF-11.1 and WF-11.2, which were kept and extended |
| [13981](selected/13981-analyze-stocks-in-telegram-with-twelve-data-gpt-4o-and-o3-mini/) Telegram stock analyst | Telegram Trigger, tools agent, reply | The same structure as WF-11.2, which now has stockPicks, africaMarkets and dangoteWatch as tools |
| [16524](selected/16524-generate-dividend-income-reports-via-telegram-with-google-gemini/) Dividend reports in Telegram | Checks the chat id against an allowlist before answering | WF-11.2 answers only the chat in `TELEGRAM_CHAT_ID`, so a stranger can't spend your OpenAI credit or FMP calls |
| [10460](selected/10460-stock-market-analysis-prediction-with-gpt-claude-gemini-via-telegram/) Multi-model analysis | GPT, Claude and Gemini each analyse, then a consensus | Not used yet: a possible second-opinion step for SM-01 |

## Fetching templates with defuddle

```
node templates/fetch-templates.mjs                     the 7 above
node templates/fetch-templates.mjs --ids 5163,3053     any template from INDEX.md
node templates/fetch-templates.mjs --match telegram    every template whose title matches
node templates/fetch-templates.mjs --all               all 340 (slow)
```

On Windows run `templates\fetch-templates.cmd` with the same options. The first run installs defuddle 0.19.6 into `templates/.tools` with the npm that comes with Node (no npx needed). The files go to `templates/defuddle/`: `<id>-<name>.md` (the page) and `<id>-<name>.workflow.json` (import it in n8n: Workflow menu → Import from File).

For an unstable connection, every download is tried 4 times (15 s, 1 min and 4 min apart), files already saved are skipped, and a file is written only once it is complete. So when it stops with "run the same command again later", just run it again. If the site itself can't be reached, the list of templates comes from GitHub instead.

The site links each template's workflow.json but does not serve it (the link answers 404), so the JSON comes from `raw.githubusercontent.com/ScraperNode/awesome-n8n-templates`.

Tested by `node tests/fetch-templates.test.mjs` against a local server shaped like the site (7 checks: defuddle output, key removal, resume, retry after a dropped connection, no retry on 404, the GitHub fallback). It was also run against pages rendered locally from the real 340 template READMEs in the site's layout, with the real workflow.json files from GitHub. The live site (github.io) could not be reached from the build machine, so the first live run is on your PC.

The awesome-n8n-templates repository is published under the MIT licence. Its templates come from n8n.io's public template library, where each author is credited.
