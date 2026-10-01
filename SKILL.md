---
name: codex-subagent
description: Run OpenAI Codex as a subagent — delegate a task to a Codex thread and drive it like a Claude subagent (background run with completion notification, steer or continue it with messages, list, stop, worktree isolation, roles). Use when the user asks to hand work to Codex, wants a Codex second opinion or review, or wants Codex agents running alongside Claude subagents.
---

# codex-subagent

`node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs <command>` (below: `CS`; always write the full path, shell state does not persist).

Each subagent is one Codex thread. While a turn runs, a **host process** (`start`, or `send` when it resumes the thread) owns it: it runs `codex app-server`, drives the thread and listens for control messages. Run the host as a **background Bash task** (`run_in_background: true`): the task exiting is your completion notification and `TaskStop` on it interrupts the turn.

The host's stdout is the subagent's event stream, written as things happen:

```
codex-subagent N: started · thread … · model/effort · sandbox … · cwd
[N] ✉ <message Codex sent you with notify>
[N] ? <question Codex asked mid-turn> (answered: no interactive user)
[N] ! <error>
[N] ■ turn 1 completed            (or failed / stopped)
━━ codex-subagent N · completed · turn 1 · 4m12s · … tokens ━━
<Codex's final message, verbatim>
── files changed this turn ── / ── worktree ── / ── error ──   (when there is something to say)
[N] □ host exited (completed)
```

## Receiving events

- **If you have a tool that keeps listening to a command's output (Monitor), listen to the host's output directly.** Start the host as a background Bash task, then attach the listener to that task's output file:
  ```
  Monitor(description: "codex subagent N", timeout_ms: 1800000, command:
    f=<output file of the host task>; tail -n +1 -f "$f" & until grep -qE '□ host exited|^\[(killed|exited with code)' "$f"; do sleep 1; done; sleep 1; kill $!)
  ```
  Do **not** run `start`/`send` as the Monitor command itself: a Monitor's expiry (≤30 min) kills its command exactly like `TaskStop`, which would stop Codex. If the Monitor expires while the host is still running, re-arm it with `tail -n 0 -f`.
- **Otherwise use `CS watch N`**, a long poll: it returns the events since the previous `watch` returned — at once if there are any, otherwise as soon as the next ones arrive. Run it as a background Bash task and, when it returns, run it again while the subagent is running. It exits 1 with `not running, no new events` once there is nothing left to wait for. `--verbose` adds commands, file changes and Codex's commentary.
- Either way the host task's own completion notification still arrives; `Read` its output file for the full report.

## Interface, next to Claude subagents

| Claude subagent | codex-subagent |
|---|---|
| `Agent(prompt, description, subagent_type, model, isolation: "worktree")`, background | `CS start --name N --description D [--role R] [--model M] [--effort E] [--worktree] - <<'EOF' … EOF` as a background task |
| foreground agent | the same command without `run_in_background` (moves to the background by itself after the Bash timeout) |
| completion notification + final report | the host task's completion notification; `Read` its output file: the events of the turn, then the Codex final message verbatim, files changed, worktree state |
| `SendMessage` to a running agent | `CS send N - <<'EOF' … EOF` → inserted into the running turn at once (`turn/steer`), no waiting for a tool boundary |
| `SendMessage` to a finished agent (resumes it) | the same `send` → a new turn in the same thread (keeps context). **Always run `send` as a background task**: it becomes the host when it starts a new turn |
| `ListAgents` | `CS list` (this Claude session; `--all` for every session, `--json`) |
| `TaskStop` | `TaskStop` on the host task, or `CS stop N` |
| agent transcript / output file | `CS log N` (progress), `CS result N` (last final message), `CS status N`, `CS transcript N` (raw app-server events) |
| subagent `SendMessage` to main | Codex runs `CS notify "…"` → a `[N] ✉ …` line in the host's output; see *Receiving events* |
| `.claude/agents/*.md` agent types | roles: `<repo>/.claude/codex-agents/*.md`, `~/.claude/codex-agents/*.md`, built-in `roles/` (`CS roles` lists them) |
| `isolation: "worktree"` (auto-removed if unchanged) | `--worktree` or `isolation: worktree` in the role: `<repo>/.claude/worktrees/codex-N` on branch `worktree-codex-N`; removed after a turn that changed nothing, recreated on the next `send` |
| `isolation: "remote"` | `--remote --env ENV_ID [--branch B]` → Codex Cloud task, polled until done, diff in the report. Codex Cloud cannot steer, continue or cancel: `send` is refused, `stop` only stops watching |

Codex has no interactive user: questions it asks mid-turn are answered with "decide or ask in your final message" and show up as `[N] ? …` events. If a turn ends with a question, answer it with `send`.

## Roles

```markdown
---
description: one line
sandbox: read-only | workspace-write | danger-full-access   # default: the user's Codex config
model: …        # optional
effort: …       # optional (low … the model's max)
isolation: worktree   # optional
extends: my-dev   # optional: prepend the body of the Claude agent .claude/agents/my-dev.md
---
Instructions for Codex (sent as developer instructions when the thread starts).
```

## Patterns

Delegate and keep working:
```
Bash(run_in_background: true, description: "Codex subagent fix-parser: …")
  node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs start --name fix-parser --description "fix the parser bug" --worktree - <<'EOF'
  <self-contained task: goal, files, constraints, how to verify, what to report>
  EOF
```
Correct course mid-turn: `CS send fix-parser - <<'EOF' … EOF` (background). Review in parallel: `CS start --role reviewer --name review-x - <<'EOF' Review git diff main...branch … EOF`.

When the notification arrives, `Read` the output file and relay what matters; do not paraphrase Codex findings as your own verification.

## Notes

- Codex binary: `$CODEX_BIN`, else the ChatGPT app's bundled CLI, else `codex` on PATH. State: `~/.claude/codex-subagents/<name>/`.
- `--worktree` branches from the HEAD of the directory `start` runs in: `cd` to the main checkout first, not into another agent's worktree.
- Names: a-z, 0-9, `-`, ≤40 chars; unique across sessions (`CS rm N` frees a name; it keeps a worktree that has changes).
- TaskStop sends SIGTERM to the task's process group and SIGKILL ~1.5 s later; the host records the stop immediately and app-server, in the same group, stops the turn and its commands.
