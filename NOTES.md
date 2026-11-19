# Notes

## Switching the installed plugin to this fork

Updating the plugin the usual way won't get you the "sp index" change. Your installed copy comes from the **original** project, `ktoetotam/stockwatcher-plugin`, not from your fork `falcon-1922/stockwatcher-plugin`, where we merged 3.10.3. That's in `~/.claude/plugins/known_marketplaces.json`. The original is still at 3.10.2, so an update there finds nothing new.

To switch the install to your fork, run these three commands in this session:

```
/plugin marketplace remove stockwatcher
/plugin marketplace add falcon-1922/stockwatcher-plugin
/plugin install stockwatcher@stockwatcher
```

- **Why remove first:** your fork's `marketplace.json` uses the same name ("stockwatcher") as the original, so the two can't be installed side by side. Removing the marketplace also uninstalls the plugin, and the install step puts it back from your fork.
- **What you keep:** saved portfolios, saved dashboards and cached research are stored separately from the plugin folder, so they survive the switch.
- **Afterwards:** restart Claude Code (or run `/reload-plugins` if your version has it) so the new skill loads. Your next dashboard request should replace the old 3.10.2 server.

Later, when you push new versions to your fork, run `/plugin`, open the Marketplaces tab, choose stockwatcher and update it. Claude Code picks up the higher version number.

One more thing: if you want people using the original project to get the change, open a PR from your fork to `ktoetotam/stockwatcher-plugin`. I can do that now that `gh` is logged in.

The removal warned that it deletes plugin data "where it can", so I'll check that your saved data survived and the new version is installed.

Now a live test with the new install. It should also replace the old server.

The plugin now installs from your fork, and version 3.10.3 is working.

- **Switched source:** the stockwatcher marketplace now points to `falcon-1922/stockwatcher-plugin` instead of `ktoetotam/stockwatcher-plugin`.
- **Installed:** version 3.10.3, in `~/.claude/plugins/cache/stockwatcher/stockwatcher/3.10.3/`.
- **Live test:** "what is the sp index now" opened the S&P 500 (500 shares) without asking for research. The dashboard server on port 4317 is now running the 3.10.3 code, so the old 3.10.2 server was replaced.
- **Your data is safe:** despite the warning during removal, your saved data is intact in `~/Library/Application Support/stockwatcher/` (`memory.json`, `views.json`). For example, the remembered "who invested in openai" research is still there.

Restart Claude Code once, or start a new session, so the skill's instructions are reloaded from the 3.10.3 folder. This session still has the 3.10.2 path from earlier.

Going forward, updates come from your fork. To get changes from the original project, pull them into your fork first. Would you like me to open a PR to `ktoetotam/stockwatcher-plugin` so the original project gets the "sp index" synonym too?

---

## How Claude knows to use the skill

You mean **stockwatcher**; there's no marketwatcher skill. Claude picks it the same way it picks any tool: by matching your words against a short description it can see.

### 1. The description is always visible to Claude

Every skill starts with frontmatter in its `SKILL.md`:

```yaml
---
name: stockwatcher
description: "Shows a live stock-market dashboard and heat map in the browser... Handles a market index..., a sector..., the person's own portfolio..., questions about companies (\"anyone who invested in OpenAI\", \"Apple's suppliers\")... Use whenever someone asks to see, watch, track, compare or chart stocks..."
---
```

When the plugin is installed (through `.claude-plugin/plugin.json` and `marketplace.json` in this repo), Claude Code adds each skill's **name and description** to the list of available skills at the start of every session. It does not load the rest of `SKILL.md`. The stockwatcher entry is in my list in this session too. Loading only the descriptions keeps them cheap: dozens of skills can be installed without filling the context.

### 2. The model matches your request against those descriptions

No router, embedding search or keyword matcher sits in between. The model reads your message, reads the skill descriptions, and judges which one fits. That's why this description is written the way it is:

- **Lots of example phrasings**: "S&P 500", "banks", "nvidia, amd and tesla", "Warren Buffett's portfolio", "anyone who invested in OpenAI". The more your wording resembles an example, the more likely the match.
- **A broad instruction**: "Use whenever someone asks to see, watch, track, compare or chart stocks... and for every follow-up."
- **Defensive lines**: "always available... never say the dashboard is unavailable" stops the model from deciding it can't help. `SKILL.md` adds "Do not answer from the web instead."

"who invested in openai" lines up almost word for word with the "anyone who invested in OpenAI" example, so the match was easy.

### 3. Then the full instructions load

Once the model decides a skill fits, it calls the `Skill` tool, and the body of `SKILL.md` is loaded into the conversation. Those instructions say to run `node .../stockwatcher.mjs "<your words>"`, how to handle `NEEDS RESEARCH`, and so on. Supporting files like `references/troubleshooting.md` load only if the instructions point to them.

**In this session:** I didn't call the `Skill` tool. I had already read `SKILL.md` while analysing the repo, so I ran the script directly from this checkout. The steps that pick the skill (steps 1 and 2) are the same either way.

### What this means

- **Choosing a skill is a judgement, not a guarantee.** Vague wording ("what's up with tech?") might get a plain web answer instead. You can force it with `/stockwatcher:stockwatcher` or by naming the skill.
- **Writing the description is the job.** For a skill author, the `description` field decides whether the skill ever gets used. That's why this one is so long and full of examples.
- **Descriptions compete.** You have several finance plugins installed (equity-research, market-researcher…). A request like "sector overview of banks" could go to `sector-overview` rather than stockwatcher, depending on which description fits better.

---

## What the skill uses a language model for

The skill itself never calls a language model. It has no API keys, no model SDK, and no requests to Anthropic or OpenAI anywhere in the code. `resolve.mjs` even says so at the top: *"using only local data … No model calls."* The only model involved is the agent the skill runs inside (Claude Code, Codex and so on), and it gets a fairly narrow set of jobs.

### What the code does without a model

Everything below is plain Node.js:

- **Reading your request** (`resolve.mjs`, about 430 lines): a hand-written synonym table ("pharma" maps to Nasdaq's pharmaceutical industries, "banks" to Banks and Savings Institutions), curated themes in `data/themes.json` (chips, AI, magnificent 7…), matching of tickers and company names against a bundled index (`index.json.gz`), and regexes for portfolio phrases like "add 5 TSLA".
- **Data**: prices from Yahoo, Nasdaq and the Moscow Exchange; 13F filings from SEC EDGAR plus OpenFIGI; r/wallstreetbets counts from ApeWisdom/Reddit; index weights for the DAX and MOEX.
- **Rendering**: a local web server and the HTML heat map, plus snapshot HTML/PNG files for remote sessions.
- **Memory**: saved portfolios, saved dashboards, cached research and request counts, all stored as local files.

### What the agent's model does

1. **Passing your words along.** For almost every request, `SKILL.md` tells the agent to run `node stockwatcher.mjs "<your words>"` exactly as you said them. The model's job here is to spot that the request is about stocks, quote it safely for the shell (removing `$`, backticks and so on), and add `--window` for follow-ups.
2. **Research. This is the only real "intelligence" step.** `research.mjs` uses a regex to flag questions about relationships between companies: investors, suppliers, competitors, "exposure to". The script can't answer those, so it prints `NEEDS RESEARCH` and hands them back. The agent then searches the web, works out the right tickers with exchange suffixes, and runs the command again with lists like `"OpenAI investors: MSFT, NVDA, 9984.T | private: Thrive Capital"`. It can also split independent questions across sub-agents. The script stores the answer for 30 days, so repeat questions need no model.
3. **Looking up index weights.** For indices that aren't built in (ASX 20, FTSE 100, SET50…), the agent finds each company's index weight or market value from a factsheet and passes it in. Without that, the script prints `SIZES MISSING`.
4. **Fixing problems the script reports.** When the output says `PRICES MISSING`, the agent works out why (wrong exchange suffix, renamed or delisted company, a US ADR it could use instead) and runs the command again.
5. **Reporting back.** It sums up what's on screen in a sentence, copies the dashboard link line, and in cloud or phone sessions publishes the snapshot as an Artifact or sends the PNG.

### Bottom line

Roughly 95% of requests are handled by keyword matching against curated tables. In those cases the model is just a launcher and a narrator. It only does real work on questions like "who invested in OpenAI" or "Apple's suppliers", where it does web research and maps companies to tickers. The design is deliberate: the script asks the model to do only what its local data can't.
