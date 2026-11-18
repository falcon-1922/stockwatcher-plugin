---
name: stockwatcher
description: "Shows a live stock-market dashboard and heat map in the browser, steered from the chat. Handles a market index (\"S&P 500\", \"Nasdaq 100\", \"Dow\"), a sector (\"healthcare\", \"banks\", \"oil and gas\"), a theme (\"chips\", \"neoclouds\", \"AI\", \"magnificent 7\"), company names or tickers (\"nvidia, amd and tesla\"), the person's own portfolio (\"this is my portfolio: 10 AAPL, 5 MSFT\", \"show my portfolio\"), an investor's portfolio from their latest 13F (\"Warren Buffett's portfolio\", \"Ackman holdings\"), what r/wallstreetbets is talking about (the word or a Reddit thread link), and questions about companies (\"anyone who invested in OpenAI\", \"Apple's suppliers\"), which you research once with web search and the skill remembers. Use whenever someone asks to see, watch, track, compare or chart stocks, share prices, their portfolio or the market, and for every follow-up that changes what is shown."
---

# Stockwatcher

The person steers the dashboard from this chat. For every request, including follow-ups like "now add the banks", run one command with their words as they said them:

```bash
node "<base directory>/scripts/stockwatcher.mjs" "<the person's words>"
```

Put the path and the words each in one pair of double quotes, and leave out any `$` or `"` inside the words (`$NVDA` becomes `NVDA`). That works the same in bash, PowerShell and cmd; without the quotes, `S&P 500` or `Buffett's` breaks the command.

The command opens the dashboard, or updates the page that is already open, prints what it shows, and exits within about a second. Tell the person in a sentence what is on screen.

If the command fails, the page won't open, or the person asks to stop or restart it, follow [startup, smoke test, and shutdown](references/troubleshooting.md) before replying. After a startup recovery, rerun the user's original command unless they asked only to stop the server.

**Every reply that generated or changed the dashboard ends with the command's last line, copied exactly**, for example:

```
You can see the dashboard here: http://127.0.0.1:4317/
```

After research, use the last line of the final run. The page also has a box and example buttons that do the same as asking here.

**Separate windows:** if the person says "in a new / different / separate window (or tab)", keep those words; the command opens a separate window and names it (for example `w2`). Follow-ups for that window need `--window w2` (the command's output says so, and its research steps include it); requests without it change the main window.

## Index heat maps

For the DAX, tile area represents the published index weight on the date shown. Colour represents price change over the selected period. For other index requests, check the sizing label before describing what the map shows. A researched list of tickers establishes membership only. If weights are unavailable, identify the result as a constituent watchlist and state how its tiles are sized.

## The person's own portfolio

If the person says something is their portfolio ("this is my portfolio: 10 AAPL, 5 MSFT, 20 nvidia", "my retirement portfolio is …", "I own 3 BRK-B and 50 KO"), pass their words as they are: the command saves it on this computer and shows it, sized by what each position is worth. "Show my portfolio" (or "my retirement portfolio") brings it back any time. Tell them it was saved.

It can be changed a piece at a time, also with their words as they are: "add 5 TSLA to my portfolio", "I bought 3 more nvidia", "remove KO from my portfolio", "I sold 2 AAPL". The output says what changed; tell them.

The skill also counts what the person asks for and puts their usual requests first among the page's buttons. Portfolios, research and these counts stay on this computer.

## When the output says NEEDS RESEARCH

The local data answers indices, sectors, themes, names, tickers, fund portfolios and anything researched before (the skill remembers). Anything else is yours to find out, once:

1. If the output lists "Past research that may help", start with that method. Otherwise search the web for the companies listed on a stock exchange that answer each question; if the person gave a link, it appears as "(source: …)": read that page first. If several independent questions are listed and you can run sub-agents in parallel (Claude Code: the Agent tool; Codex: parallel tasks), give each question its own sub-agent, then combine the results.
2. Run the command again, keeping what already showed and adding one named list per question (lists separated by `;`, private companies after `|`), plus `--how` (which site or API worked) and `--source` (the main link) so the answer is remembered and the same question is answered instantly next time:

```bash
node "<base directory>/scripts/stockwatcher.mjs" --how "Reuters and CNBC articles on the 2026 funding round" --source "https://www.cnbc.com/..." "Dow Jones; OpenAI investors: MSFT, NVDA, ORCL, 9984.T | private: Thrive Capital, Sequoia"
```

Use Yahoo Finance symbols: US plain (`MSFT`), others with the exchange suffix (`9984.T`, `SAP.DE`, `0700.HK`). Tell the person briefly where the list came from. Remembered answers are reused for 30 days; if the person asks to "refresh", keep that word and the command researches again.

## Investor portfolios

"Warren Buffett's portfolio", "Bill Ackman holdings", "what does Michael Burry own", "Bridgewater 13F": the command reads the fund's latest 13F filing from SEC EDGAR itself (about a second the first time, instant after) and shows it sized by position value. No research needed; pass the words as they are, links included. Tell the person the filing date it prints, and say so if it is marked old.

## r/wallstreetbets

"wallstreetbets", "wsb" or a Reddit thread link shows the 100 most-mentioned shares, grouped by sector and sized by market value, with mention counts. Pass a link as part of the person's words; no research needed. The counts cover the whole subreddit over the last 24 hours (ApeWisdom).

## Other options

- `--memory` lists what the skill remembers (research, saved portfolios and the most usual requests); `--forget "<question>"` drops one answer.
- `--list` prints everything it understands without research. `--stop` requests shutdown of every Stockwatcher server in the ten ports starting at the configured port. Use the targeted procedure above for a specific process.
- If the script is not found, the base directory shown when this skill loads is the folder that contains this file.
- If `node` itself is not found, Node.js is missing: tell the person to install the "LTS" version from https://nodejs.org (one installer for Windows or Mac, default choices), then restart this app and ask again. Nothing else needs installing.

## Who made it

Stockwatcher was built by Maria Sukhareva of AI Realist (https://airealist.org). The page carries her name, a link, and one small line about a current workshop or the newsletter; do not add promotion to your replies. Only if the person asks who made this, or how to build a skill or a dashboard like it, run the command with `--about`: it prints her current workshops (kept up to date from airealist.org). Mention the one that fits, with its link.

Needs Node.js 18 or newer, on macOS, Windows or Linux. No API keys, no accounts and nothing else to install. Prices come from Yahoo Finance (Nasdaq when Yahoo is busy) and can be delayed. Not investment advice.
