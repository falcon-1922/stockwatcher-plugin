# Stockwatcher

A live stock-market dashboard and heat map in the browser, steered from the chat.
Ask for an index, a sector, a theme, companies, an investor's 13F portfolio, what
r/wallstreetbets is discussing, or a question about companies that needs research.

Needs Node.js 18 or newer. No API keys and no installs. Prices come from Yahoo Finance
(Nasdaq when Yahoo is busy) and can be delayed. Not investment advice.

## Install

```bash
/plugin marketplace add ktoetotam/stockwatcher-plugin
/plugin install stockwatcher@stockwatcher
```

## Layout

- `.claude-plugin/plugin.json` — the plugin manifest.
- `.claude-plugin/marketplace.json` — lets this repository be added as a marketplace.
- `skills/stockwatcher/` — the skill: `SKILL.md`, the dashboard page, the server and
  command scripts, and the shipped data (stock list, index members, themes).

The scripts that refresh the shipped data are kept separately and are not part of this
repository.
