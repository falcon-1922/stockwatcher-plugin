# Phones, cloud sessions and hosting

Stockwatcher's live page comes from a small server on the machine that runs the command. That only helps when it is the person's own computer. When they ask from a phone, the command runs on a cloud machine they cannot reach. This covers Claude on a phone or the web, the ChatGPT/Codex app, and Codex cloud tasks. Each answer then comes with a **snapshot**: one HTML page with the prices built in, plus a PNG of it. This page says what to do with them, and what to propose when the person wants the dashboard to stay live on their phone.

## What works where today

| The person asks from | What they get | Live? |
|---|---|---|
| Claude Code / Codex on their own computer | the page at `127.0.0.1` | yes, every minute |
| Claude app or claude.ai (phone, web), cloud session | the snapshot published as a claude.ai Artifact (Artifact tool) | no: a fresh one each time they ask |
| ChatGPT / Codex app on a phone, Codex cloud task | the PNG in the reply (or the HTML file) | no, **and only if the task can reach the price feeds** (below) |
| Any chat that can only show text | the list of shares the command prints, in words | no |

There is no documented way for the command to tell that it runs in Codex cloud. Set `STOCKWATCHER_SNAPSHOT=1` in the Codex environment's variables, or pass `--snapshot`, so it always makes the snapshot there.

## Codex cloud: prices need internet access

In Codex cloud tasks the agent has **no internet by default**: the setup script does, the agent does not. Every share then comes back without a price, and the command prints `NO PRICES`. Do not send that grey page as if it were live. Tell the person, and propose that they turn on agent internet access for the environment (Codex → environment settings → Agent internet access → On, with a domain allowlist) and allow these hosts:

```
query1.finance.yahoo.com
query2.finance.yahoo.com
fc.yahoo.com
api.nasdaq.com
iss.moex.com        (Moscow shares)
www.sec.gov
data.sec.gov
efts.sec.gov        (investor 13F portfolios)
apewisdom.io        (r/wallstreetbets)
api.openfigi.com    (ticker names)
```

Then ask again. The snapshot and picture now have prices, but they are still pictures of one moment.

## A dashboard that stays live on a phone: host it

A phone can only show a live dashboard from a web address it can open. So Stockwatcher has to run somewhere public, not on the agent's machine. **The plugin does not include a hosted version yet.** When the person wants one, tell them so and propose this. Do not set it up without their go-ahead, because it creates a public service on their account.

**Recommended: a Cloudflare Worker (free tier).**
- The page is served from the Worker, at an address like `https://stockwatcher.<their-subdomain>.workers.dev/`.
- The Worker fetches prices itself, so the agent's machine needs no internet.
- The whole view goes in the link, e.g. `?q=Chips: NVDA, AMD, TSM`. Named lists already carry their tickers, so the Worker needs no memory. Any agent, Codex cloud with no internet included, can then answer with just that link, and it opens live on any phone.
- **Feeds tested from a Worker (19 Nov 2026):** Yahoo's chart endpoint (`/v8/finance/chart`), Nasdaq and the Moscow Exchange answered with live prices. Yahoo's quote endpoint (`/v7/finance/quote`) needs the cookie-and-crumb session that `scripts/lib/yquote.mjs` does, which was not tried from a Worker. Fall back to the chart endpoint if it fails.
- **The port is moderate.** `server.mjs`, `resolve.mjs`, `prices.mjs` and the `data/` files (about 190 KB) carry over. What uses the file system changes: the price cache moves into memory or Workers KV. Research memory and saved portfolios stay on the person's own computer. A portfolio can go in the link's `#fragment`, which browsers never send to a server.

**Not recommended as it is: running `serve.mjs` on a public server.** The server accepts only requests addressed to `127.0.0.1`, and it has no login. Saved portfolios and research would be open to anyone with the address. Hosting it that way needs a code change and authentication first.

## When nothing can show a page

If a chat cannot open links or files at all, send the PNG the command made. With no PNG (no Playwright or Chromium on the machine), say so, and describe what the dashboard shows in a few lines from the command's output: the groups, the biggest moves today, and anything without a price. Never send the `127.0.0.1` link to someone who is not on that machine.
