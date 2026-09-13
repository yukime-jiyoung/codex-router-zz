# Keeping the picker current

Providers add and retire models on their own schedule. Without something
watching, the gap between "it exists" and "it is in your picker" is a person
noticing.

```sh
node tools/auto-update/sync-models.mjs            # report what it would add
node tools/auto-update/sync-models.mjs --apply    # add what passes
```

Nothing is added because a catalog mentions it. Each candidate has to answer a
real turn, and on a Responses provider it has to clear the compatibility probe
first. That gate is the reason this is safe to schedule: a model that is listed
but refuses the shapes Codex sends will fill a picker with entries that fail on
first use, and one of those failures — a tool call the endpoint rejects — is
replayed on every later turn, so a single one ends the conversation for good.

## What it will not do

| | Why |
|---|---|
| Remove anything | A rename, an outage and a retirement look identical from here, and only one is answered by dropping a route. Models the provider stopped serving are reported. |
| Touch an unselected or uncredentialed provider | This keeps an existing setup current. It does not enable or pay for anything. |
| Treat a rate limit as a verdict | A throttled candidate waits for the next run instead of being recorded as broken. |
| Add a model restricted to its provider's own client | Measured, not guessed: the same request is sent without the header the provider uses to recognise its client, and a refusal naming that restriction is taken at face value. `--include-restricted` overrides it. |
| Test an unbounded number of candidates | A turn against a paid model is a charge. `--budget` (default 10) caps a run; the rest wait. |

## Options

| | |
|---|---|
| `--providers a,b` | Only these. Default: every selected, credentialed provider. |
| `--budget N` | Test at most N candidates this run. Default 10. |
| `--only id1,id2` | Consider only these model ids — answers a question about one model without paying for the forty that sort ahead of it. |
| `--apply` | Actually add what passes. Without it, nothing is written. |
| `--include-restricted` | Also add models the provider restricts to its own client. |
| `--json` | Machine-readable summary on stdout. |

Every run appends one JSON line to `sync-models.log` in the router's state
directory, so a scheduled run leaves a record of what it saw and why.

New models appear in the picker the next time Codex starts. Nothing has to be
clicked.

## Running it on a schedule

Weekly is enough; providers do not move faster than that. Use `--budget` to
bound what a single run can spend.

**macOS** — `~/Library/LaunchAgents/ai.opencode.omc-sync.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.opencode.omc-sync</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/path/to/omc-codex/tools/auto-update/sync-models.mjs</string>
    <string>--apply</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer>
  </dict>
</dict></plist>
```

**Linux** — a systemd user timer, `~/.config/systemd/user/omc-sync.service`
plus `omc-sync.timer`, enabled with `systemctl --user enable --now omc-sync.timer`:

```ini
# omc-sync.service
[Service]
Type=oneshot
ExecStart=/usr/bin/env node /path/to/omc-codex/tools/auto-update/sync-models.mjs --apply

# omc-sync.timer
[Timer]
OnCalendar=Mon 09:00
Persistent=true
[Install]
WantedBy=timers.target
```

**Windows** — one scheduled task:

```powershell
$action  = New-ScheduledTaskAction -Execute "node" `
  -Argument "C:\path\to\omc-codex\tools\auto-update\sync-models.mjs --apply"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName "OMC model sync" -Action $action -Trigger $trigger
```

`Persistent` on Linux and the equivalent elsewhere matter more than the exact
hour: a machine that was asleep on Monday should still catch up rather than
skip a week.
