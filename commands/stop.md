---
description: Stop the Stockwatcher dashboard server running on this computer
allowed-tools: Bash(node:*)
---

The Stockwatcher stop command was run:

!`node "${CLAUDE_PLUGIN_ROOT}/skills/stockwatcher/scripts/stockwatcher.mjs" --stop`

Tell the person in one sentence what the output above says: either the server was stopped, or it was not running. Any open dashboard tab stops updating; the next dashboard request starts the server again. Do not run anything else.
