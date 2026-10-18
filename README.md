# pi-tmux-subagent

Visible, interactive subagents for pi using tmux.

## Install

From a git remote:

```bash
pi install git:github.com/<you>/pi-tmux-subagent
```

From a local copy (e.g. after `scp -r ~/src/pi-tmux-subagent otherbox:`):

```bash
pi install ./pi-tmux-subagent
```

Or without packaging, just drop the extension folder in place:

```bash
scp -r ~/.pi/agent/extensions/tmux-subagent otherbox:.pi/agent/extensions/
```

Requirements: `pi` and `tmux` on PATH. Reload running sessions with `/reload` after install.

The orchestrator gets a `subagent_tmux` tool. Each call opens a **new tmux window running an
interactive pi session** (the subagent). A human can switch to that window anytime, watch the
work live, and type messages to the subagent. When the subagent calls `subagent_done`, its
report is written to disk, its pi session shuts down gracefully, the tmux window closes, and
the report is returned to the orchestrator as the tool result so it can continue.

## Files

- `index.ts` — orchestrator-side extension (auto-loaded from `~/.pi/agent/extensions/`)
- `done.ts` — worker-side extension, injected into the subagent via `pi -e`

## Usage (by the orchestrator model)

```
subagent_tmux({
  task: "Refactor X and run the tests. Report what changed.",
  title: "refactor-x",          // optional, window label
  cwd: "/path/to/repo",         // optional, defaults to orchestrator cwd
  model: "provider/modelId",    // optional
  timeout_ms: 1800000           // optional
})
```

The tool blocks until the subagent reports. If not running inside tmux, it creates a detached
session instead: `tmux attach -t pi-sub-<id>`.

## Lifecycle

1. Job dir: `/tmp/pi-tmux-subagent/<id>/` (`task.md`, `instructions.md`, `run.sh`,
   `session.jsonl`, `result.json`, `orchestrator.log`, `pi.log`)
2. `run.sh` launches: `pi --session session.jsonl --append-system-prompt instructions.md -e done.ts "<bootstrap prompt>"`
3. Subagent works; human may interact live in the window
4. Subagent calls `subagent_done(report)` → writes `result.json`, `ctx.shutdown()`
5. `run.sh` kills its own window; orchestrator returns the report

## Failure modes

- Subagent exits/crashes without reporting → window stays open ("press enter to close"),
  orchestrator gets an error with the transcript path after 3 missed liveness checks
- Orchestrator abort (Ctrl+C / new input) or timeout → window is killed
- Worker stderr is captured in `pi.log`; orchestrator polling in `orchestrator.log`

## Notes

- The subagent is a full interactive pi with all your extensions — it can even spawn its own
  subagents.
- The subagent's session is persisted (`session.jsonl`), so you can resume/review its work later.
