# Stockwatcher startup, smoke test, and shutdown

The scripts are in the `scripts` folder next to SKILL.md (`skills/stockwatcher/scripts/`). Use the same skill installation throughout.

## Startup failure

If the output starts with `BLOCKED BY THE SANDBOX`, skip everything below: rerun the same command with escalated permissions, as the output says.

1. Check `node --version` (18 or newer). Use the actual port printed by Stockwatcher. With no port in the output, the launcher starts at 4317 by default (overridden by `--port` or `STOCKWATCHER_PORT`) and checks ten consecutive ports. The following macOS commands use the defaults. Replace the port and range as needed.

   ```bash
   curl --noproxy '*' --max-time 2 --fail --silent --show-error http://127.0.0.1:4317/api/health
   lsof -nP -iTCP:4317-4326 -sTCP:LISTEN
   tail -n 25 "$HOME/Library/Caches/stockwatcher/server.log"
   ```

   The health response identifies Stockwatcher by `app: "stockwatcher"` and reports its PID, version, number of loaded stocks, and viewers. The launcher's expected version is `VERSION` in `scripts/lib/home.mjs`. A PID in an old log line is historical. The log is under `STOCKWATCHER_HOME` if set. On Linux it defaults to `$XDG_CACHE_HOME/stockwatcher` or `~/.cache/stockwatcher`. On Windows it defaults to `%LOCALAPPDATA%\stockwatcher`.

2. If the CLI says `could not start its local server` and there are no fresh log entries, run the isolated smoke test below. The launcher treats any bind error as an unavailable port and can fail before it opens the log. If the test returns `EPERM` or `EACCES` while binding loopback, use the managed environment's host execution approval path for the smoke test when available. The original command can also need host execution for loopback access and writes to Stockwatcher's cache or data directories. An unchanged log does not establish a port collision, a version mismatch, or a server crash. If approval is rejected, report the rejected operation and reason.
3. For `EADDRINUSE`, identify the current listener. For an unrelated listener, leave it alone and use `--port` with a free starting port. For a verified stale Stockwatcher instance that blocks recovery, follow the targeted shutdown below. For a fresh crash or write error, use the newest log entry to diagnose the error before retrying. The index builders (`build-index.mjs`, `build-indices.mjs`) refresh bundled market datasets. They do not start the server and are not part of startup recovery.
4. After addressing the cause, rerun the original command with its query and window options. If the startup succeeds but the browser doesn't open, check the printed URL and open it explicitly. `--no-open` still updates the view and is useful when isolating browser launch issues. Share the dashboard link only after the command succeeds. If recovery is still blocked, report the observed error and what remains unavailable.

## Isolated smoke test

Run this for startup diagnosis or after changing launch or dashboard code.

```bash
node "<folder of SKILL.md>/scripts/smoke-test.mjs"
```

A pass confirms the launcher can start a server on loopback, serve the dashboard, resolve `real estate stocks` from the bundled index, and shut down its test server. It uses a temporary port and temporary cache and data folders, disables browser launch and external quote calls, and leaves the person's saved state alone. Run the actual query afterward for a live dashboard.

## Stop a specific process, then verify

1. Resolve the current port and PID. Use `/api/health` and confirm the PID matches the OS listener. If the endpoint is unresponsive, inspect the listener's current command line. On macOS or Linux, use `ps -p PID -o pid=,command=`, with `PID` replaced by the numeric listener PID. Look for Stockwatcher's `scripts/serve.mjs` path on that process. On Windows, use `Get-NetTCPConnection -LocalPort 4317 -State Listen` and inspect its `OwningProcess` with `Get-CimInstance Win32_Process -Filter "ProcessId = PID"`. Do not signal a process based on its name (`node`) or on a PID copied from `server.log`.
2. Prefer the graceful stop endpoint for the verified Stockwatcher port. This lets the server flush its price cache.

   ```bash
   curl --noproxy '*' --max-time 2 --fail --silent --show-error http://127.0.0.1:4317/api/stop
   ```

   If the request covers all Stockwatcher servers in the configured range, the launcher also accepts `--stop`. Its status line does not prove a process has exited.
3. If the graceful request fails or the process remains after a brief wait, recheck that the same PID still owns the port and is Stockwatcher. Then use `kill -TERM PID` on macOS or Linux, or `Stop-Process -Id PID` on Windows. Replace `PID` with the verified current number. If the sandbox denies the signal, use the host execution approval path scoped to that single command and PID. Avoid bulk signals and force kills.
4. Recheck the port with the OS listener command. An empty result confirms that the port is free. If another PID owns it now or it never closed, report that fact. For a stop-only request, finish here. For startup recovery or a requested restart, rerun the original dashboard command and confirm its output.
