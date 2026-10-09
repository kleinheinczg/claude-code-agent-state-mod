# agent-state

A Claude Code mod that reports what a session is **really** doing, from inside the session, instead of guessing it
from the terminal screen.

If you run Claude Code sessions unattended (in tmux, as background agents, several at once), the usual way to know
whether one is busy, stuck on a permission prompt, or idle with a half-typed prompt is to scrape the screen. That
breaks on every rendering change, and a dim autocomplete suggestion looks exactly like text someone typed. This mod
asks the engine instead and writes the answer to two plain files you can read from anything.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-state --marketplace kleinheinczg/claude-code-agent-state-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope: every session from then on).

## What it writes

Per session, in `~/.claude/agent-state/` (change it with the `outputDir` option in `/config`):

| file | content |
|---|---|
| `<session-id>.json` | the current snapshot, rewritten on every change and every 30 s |
| `<session-id>.jsonl` | the event log: state changes, signal changes, token use per turn (written in batches; rolls over to `.jsonl.1` past ~1 MB) |

Snapshot:

```json
{
  "schema": 1,
  "session_id": "3f2a9c1e-...",
  "cwd": "/work/project",
  "cc_version": "2.1.295",
  "session_started_ms": 1791550000123,
  "state": "tool",
  "tool": "Bash",
  "state_since_ms": 1791550123456,
  "heartbeat_ms": 1791550125000,
  "signals": { "draft": { "value": "", "at_ms": 1791550120000 }, "context": { "value": "41", "at_ms": 1791550124000 } }
}
```

**`state`**: `idle` · `working` (the model is answering) · `tool` (a tool runs; `tool` names it) · `permission`
(a permission prompt is waiting for a person; `tool` names the tool) · `ended`.

**Liveness:** the heartbeat rewrites the snapshot every 30 s. A `heartbeat_ms` older than about a minute means the
session (or the mod) is not running, whatever `state` says.

**`signals`**:

| signal | value |
|---|---|
| `draft` | `1` while text waits in the prompt box (never the text) |
| `suggest` | `1` while the dim autocomplete suggestion shows (never its text) |
| `command` | the slash command running, by name only, `''` when it returned |
| `turn_end` | how the last turn ended (`answer`, `aborted`, ...) |
| `quota_5h`, `quota_7d` | the rate-limit window fill, whole percent |
| `context` | the context window fill, whole percent |
| `background`, `background_proc` | background agent work / background processes still running |
| `session_end` | why the session ended (`clear`, `logout`, ...) |
| `api_error`, `notice` | see the note below |

Event log lines:

```json
{"t":1791550123456,"kind":"state","state":"tool","tool":"Bash"}
{"t":1791550124000,"kind":"signal","signal":"context","value":"41"}
{"t":1791550130000,"kind":"usage","model":"claude-opus-5-5","sub_agent":false,"input":12,"output":480,"cache_read":91000,"cache_creation":2100}
```

Token use is summed per turn **and per model**: a turn that fell back to another model mid-way books each model its own line.

## Privacy

Nothing you type leaves the session through this mod: the prompt box is reported only as *whether* text waits,
the suggestion only as *whether* it shows, a slash command by name without its arguments, token use as numbers and the
model name. The files are written only to your own disk; the mod makes no network call.

## Lessons measured while building it (useful for other mod authors)

1. **`classic.*` events did not reach the mod live** (Claude Code 2.1.294 and 2.1.295). The settings-hook events
   (`classic.Stop`, `classic.Notification`, `classic.StopFailure`, `classic.PermissionRequest`) fire in the plugin test
   kit, and the same hooks configured in `settings.json` ran in the same live session, yet not one event arrived at the
   mod's `classic.*` hooks. So:
   - the **permission state** comes from `tool.check`: its result's `decision === 'ask'` arrived about 0.8 s before
     the dialog showed (and `allow` under bypass mode, so the mode is already in the verdict);
   - the **background count** comes from the starting tool's result (`backgroundTaskId`, `async_launched`) and the
     task's terminal `<task-notification>`, not from `classic.Stop`'s `background_tasks`.
   The `classic.StopFailure` and `classic.Notification` hooks stay registered: on an engine that delivers them, the
   `api_error` and `notice` signals start filling with no change here.
2. **A late verdict must not outlive its turn.** A `tool.check` answer can land after the turn was interrupted; counted
   as-is it marks an idle session as waiting for permission, and the heartbeat keeps that fresh. The mod counts an
   `ask` only while the turn that asked is still open.
3. **The dim suggestion is not typed text.** The engine reports it separately (`prompt.suggest`); only Tab or the right
   arrow puts it in the box, and only then does `draft` turn `1`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see `LICENSE`.
