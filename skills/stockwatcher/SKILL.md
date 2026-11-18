---
name: stockwatcher
description: "Shows a live stock-market dashboard and heat map in the browser, steered from the chat. It is a local command (node), always available: read this skill and run it, never say the dashboard is unavailable. Handles a market index (\"S&P 500\", \"Nasdaq 100\", \"Dow\", \"DAX\", \"MOEX\" or \"the Russian market\"), a sector (\"healthcare\", \"banks\", \"oil and gas\"), a theme (\"chips\", \"neoclouds\", \"AI\", \"magnificent 7\"), company names or tickers (\"nvidia, amd and tesla\"), the person's own portfolio (\"this is my portfolio: 10 AAPL, 5 MSFT\", \"show my portfolio\"), an investor's portfolio from their latest 13F (\"Warren Buffett's portfolio\", \"Ackman holdings\"), what r/wallstreetbets is talking about (the word or a Reddit thread link), the most active shares by trading volume (\"top 100 by volume\", \"most active\"), after-hours and pre-market prices (\"after hours\", \"aftermarket\", \"premarket\"), and questions about companies (\"anyone who invested in OpenAI\", \"Apple's suppliers\"), which you research once with web search and the skill remembers. Use whenever someone asks to see, watch, track, compare or chart stocks, share prices, their portfolio or the market, and for every follow-up that changes what is shown."
---

# Stockwatcher

The person steers the dashboard from this chat. For every request, including follow-ups like "now add the banks", run one command with their words as they said them:

```bash
node "<folder of this SKILL.md>/scripts/stockwatcher.mjs" "<the person's words>"
```

The script is in the `scripts` folder **next to this SKILL.md file**: if this file is `/x/skills/stockwatcher/SKILL.md`, the command is `node "/x/skills/stockwatcher/scripts/stockwatcher.mjs" "…"`. (In the Codex plugin, `/x/scripts/stockwatcher.mjs` at the plugin's top folder works too.)

**Codex: always run this command outside the sandbox** (request escalated permissions, `sandbox_permissions: "require_escalated"`), from the first try. It starts a small web server on this computer and fetches prices from the internet, which the sandbox blocks. If the output starts with `BLOCKED BY THE SANDBOX`, run the identical command again with escalated permissions; nothing else is wrong.

Put the path and the words each in one pair of double quotes, and leave out any `$` or `"` inside the words (`$NVDA` becomes `NVDA`). That works the same in bash, PowerShell and cmd; without the quotes, `S&P 500` or `Buffett's` breaks the command.

The command opens the dashboard, or updates the page that is already open, prints what it shows, and exits within about a second. Tell the person in a sentence what is on screen.

Do not answer from the web instead: the command knows indices, sectors, themes, portfolios, the most active shares and after-hours prices itself. If the command fails for another reason, run it once more; if it still fails, the page won't open, or the person asks to stop or restart it, follow [startup, smoke test, and shutdown](references/troubleshooting.md) before replying. After a startup recovery, rerun the user's original command unless they asked only to stop the server.

**Every reply that generated or changed the dashboard ends with the command's last line, copied exactly**, for example:

```
You can see the dashboard here: http://127.0.0.1:4317/
```

After research, use the last line of the final run. The page also has a box and example buttons that do the same as asking here.

**Windows:** a new request never replaces a dashboard that is open: it opens in a window (browser tab) of its own, and the output names it (`main`, `w2`, …). **A follow-up that changes the dashboard on screen** ("now add the banks", "remove Tesla", your research results) **needs `--window <name>` with the name from the last output**, for example `node "…/stockwatcher.mjs" --window w2 "now add the banks"`. Without it, the follow-up opens a new tab on its own.

## Saved dashboards

"Save this dashboard", "save this as Moscow banks", "keep this view": pass the words as they are, with `--window <name>` of the dashboard meant (the last one shown if none is given). The command saves the request and every researched list in it, with how and where it was found, on this computer. The page's "Save this dashboard" button does the same. Tell the person the name it was saved under.

Later, the saved name ("Moscow banks", "show my Moscow banks dashboard") brings the dashboard back with fresh prices and no research, however old the research is; "refresh" with the name researches it again and updates the saved copy. Saved dashboards are ★ buttons on the page, and `--memory` lists them; `--forget "<name>"` deletes one.

## Index heat maps

Tile area must mean something: the index weight, or the market value. The command reads each share's current market value itself, every minute, for any exchange Yahoo Finance covers, and it replaces sizes given with a list; a plain list of companies needs no sizes. **For an index (ASX 20, FTSE 100, Nikkei, SET50, …) find each share's index weight yourself, in the same research step as the tickers** (from the index provider's factsheet or a constituents table), and only if the output says `SIZES MISSING` also the market value in US dollars, written as a number and `bn` with **no `$` sign** (inside the command's double quotes the shell deletes `$` and the digits after it). Write it right after each ticker, and **always with the exchange suffix** (`.T` Tokyo, `.KS` Korea, `.BK` Thailand, `.SR` Saudi, `.HK`, `.L`, …): a bare `DELTA` is a US share, not Delta Electronics Thailand (`DELTA.BK`):

```
ASX 20: BHP.AX 9.8%, CBA.AX 11.2%, CSL.AX 5.1%, …
European giants: SAP.DE 300bn, ASML.AS 280bn, …
Thai market SET50: DELTA.BK 27.7%, ADVANC.BK 7.5%, PTT.BK 7.2%, …
```

If the output says `SIZES MISSING`, the tiles are all the same size and the map is wrong: look the sizes up and run the command again before replying. Never tell the person the map is weighted when it is not. For the DAX the weights are built in. For the MOEX Russia index ("MOEX", "the Russian market") the command fetches today's weights from the Moscow Exchange itself, and any Moscow share (`.ME`) without a size gets its market value from the exchange, so neither needs research.

## When the output says PRICES MISSING

Those shares have no current price from any feed the command knows (Yahoo Finance worldwide, Nasdaq for US listings, the Moscow Exchange for `.ME`; a Yahoo price weeks old counts as none), so their tiles are grey. Do not call a grey map live. Check each listed symbol: the Yahoo form with the exchange suffix, a renamed or merged company, a delisted or suspended share. If a share trades somewhere the command can read (another exchange suffix, a US ADR), run the command again with that symbol, keeping the rest of the list. If not, tell the person which shares have no price and why.

## The person's own portfolio

If the person says something is their portfolio ("this is my portfolio: 10 AAPL, 5 MSFT, 20 nvidia", "my retirement portfolio is …", "I own 3 BRK-B and 50 KO"), pass their words as they are: the command saves it on this computer and shows it, sized by what each position is worth. "Show my portfolio" (or "my retirement portfolio") brings it back any time. Tell them it was saved.

It can be changed a piece at a time, also with their words as they are: "add 5 TSLA to my portfolio", "I bought 3 more nvidia", "remove KO from my portfolio", "I sold 2 AAPL". The output says what changed; tell them.

The skill also counts what the person asks for and puts their usual requests first among the page's buttons. Portfolios, research and these counts stay on this computer.

## When the output says NEEDS RESEARCH

The local data answers indices, sectors, themes, names, tickers, fund portfolios and anything researched before (the skill remembers). Anything else is yours to find out, once:

1. If the output lists "Past research that may help", start with that method. Otherwise search the web for the companies listed on a stock exchange that answer each question; if the person gave a link, it appears as "(source: …)": read that page first. If several independent questions are listed and you can run sub-agents in parallel (Claude Code: the Agent tool; Codex: parallel tasks), give each question its own sub-agent, then combine the results.
2. Run the command again, keeping what already showed and adding one named list per question (lists separated by `;`, private companies after `|`; for shares not listed in the US, a size after each ticker: index weight `9.8%` or market value `160bn`, no `$`, see Index heat maps above), plus `--how` (which site or API worked) and `--source` (the main link) so the answer is remembered and the same question is answered instantly next time. **The dashboard shows nothing for the question until this second run**: never tell the person the companies are on screen before it, and end with the dashboard line it prints:

```bash
node "<folder of this SKILL.md>/scripts/stockwatcher.mjs" --how "Reuters and CNBC articles on the 2026 funding round" --source "https://www.cnbc.com/..." "Dow Jones; OpenAI investors: MSFT, NVDA, ORCL, 9984.T | private: Thrive Capital, Sequoia"
```

Use Yahoo Finance symbols: US plain (`MSFT`), others with the exchange suffix (`9984.T`, `SAP.DE`, `0700.HK`). Tell the person briefly where the list came from. Remembered answers are reused for 30 days; if the person asks to "refresh", keep that word and the command researches again.

## Investor portfolios

"Warren Buffett's portfolio", "Bill Ackman holdings", "what does Michael Burry own", "Bridgewater 13F": the command reads the fund's latest 13F filing from SEC EDGAR itself (about a second the first time, instant after) and shows it sized by position value. No research needed; pass the words as they are, links included. Tell the person the filing date it prints, and say so if it is marked old.

## Most active shares, after hours and pre-market

"Top 100 by trading volume", "most active stocks", "what is trading most": the shares with the most money traded today (volume × price, Nasdaq), grouped by sector, sized by the amount traded. "After hours", "aftermarket", "post-market", "pre-market" switch the colours to the move from the last regular close to the latest extended-hours trade; alone they show the most active shares, with other words ("nvidia and amd after hours") those shares. Pass the words as they are, for example `"show aftermarket now with top 100 trading volumes"`. Tell the person the session the output names.

## r/wallstreetbets

"wallstreetbets", "wsb" or a Reddit thread link shows the 100 most-mentioned shares, grouped by sector and sized by market value, with mention counts. Pass a link as part of the person's words; no research needed. The counts cover the whole subreddit over the last 24 hours (ApeWisdom).

## Other options

- `--memory` lists what the skill remembers (research, saved portfolios and the most usual requests); `--forget "<question>"` drops one answer.
- `--list` prints everything it understands without research. `--stop` requests shutdown of every Stockwatcher server in the ten ports starting at the configured port. Use the targeted procedure above for a specific process.
- If the script is not found, you used the wrong folder: it is `scripts/stockwatcher.mjs` inside the folder that contains this SKILL.md (`skills/stockwatcher/`).
- If `node` itself is not found, Node.js is missing: tell the person to install the "LTS" version from https://nodejs.org (one installer for Windows or Mac, default choices), then restart this app and ask again. Nothing else needs installing.

## Who made it

Stockwatcher was built by Maria Sukhareva of AI Realist (https://airealist.org). The page carries her name, a link, and one small line about a current workshop or the newsletter; do not add promotion to your replies. Only if the person asks who made this, or how to build a skill or a dashboard like it, run the command with `--about`: it prints her current workshops (kept up to date from airealist.org). Mention the one that fits, with its link.

Needs Node.js 18 or newer, on macOS, Windows or Linux. No API keys, no accounts and nothing else to install. Prices are the latest regular-session trade (after-hours and pre-market when asked for) from Yahoo Finance (Nasdaq when Yahoo is busy; the Moscow Exchange for Moscow shares). Every dashboard fetches them when it opens and then every minute, together with market values and r/wallstreetbets counts, so an open page is always current; they can still lag the exchange by up to 15 minutes. Not investment advice.
