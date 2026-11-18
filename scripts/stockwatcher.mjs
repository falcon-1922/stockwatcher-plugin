#!/usr/bin/env node
// Shortcut from the plugin's top folder, so both of these work:
//   node "<plugin>/scripts/stockwatcher.mjs" "nvidia, amd and tesla"
//   node "<plugin>/skills/stockwatcher/scripts/stockwatcher.mjs" "nvidia, amd and tesla"
// The real command is in skills/stockwatcher/scripts/.
import { pathToFileURL, fileURLToPath } from 'node:url';
await import(pathToFileURL(fileURLToPath(new URL('../skills/stockwatcher/scripts/stockwatcher.mjs', import.meta.url))).href);
