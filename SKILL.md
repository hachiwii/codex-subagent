---
name: codex-subagent
description: Run OpenAI Codex as a subagent — delegate a task to a Codex thread and drive it like a Claude subagent (background run with completion notification, steer or continue it with messages, list, stop, worktree isolation, roles). Use when the user asks to hand work to Codex, wants a Codex second opinion or review, or wants Codex agents running alongside Claude subagents.
---

# codex-subagent

`node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs <command>` (below: `CS`; always write the full path, shell state does not persist).

Each subagent is one Codex thread. While a turn runs, a **host process** owns it: it runs `codex app-server`, drives the thread and listens for control messages. Run the host as a **background Bash task** (`run_in_background: true`): the task exiting is your completion notification, its output file holds the report, and `TaskStop` on it interrupts the turn.

## Interface, next to Claude subagents

| Claude subagent | codex-subagent |
|---|---|
| `Agent(prompt, description, subagent_type, model, isolation: "worktree")`, background | `CS start --name N --description D [--role R] [--model M] [--effort E] [--worktree] - <<'EOF' … EOF` as a background task |
| foreground agent | the same command without `run_in_background` (moves to the background by itself after the Bash timeout) |
| completion notification + final report | the task's completion notification; `Read` its output file: the Codex final message verbatim, then messages-to-main, files changed, worktree state |
| `SendMessage` to a running agent | `CS send N - <<'EOF' … EOF` → inserted into the running turn at once (`turn/steer`), no waiting for a tool boundary |
| `SendMessage` to a finished agent (resumes it) | the same `send` → a new turn in the same thread (keeps context). **Always run `send` as a background task**: it becomes the host when it starts a new turn |
| `ListAgents` | `CS list` (this Claude session; `--all` for every session, `--json`) |
| `TaskStop` | `TaskStop` on the host task, or `CS stop N` |
| agent transcript / output file | `CS log N` (progress), `CS result N` (last final message), `CS status N`, `CS transcript N` (raw app-server events) |
| subagent `SendMessage` to main | Codex runs `CS notify "…"`; arm `Monitor` on `CS watch N` to be notified at once (Monitor expires after ≤30 min: re-arm). Otherwise they appear in the turn report |
| `.claude/agents/*.md` agent types | roles: `<repo>/.claude/codex-agents/*.md`, `~/.claude/codex-agents/*.md`, built-in `roles/` (`CS roles` lists them) |
| `isolation: "worktree"` (auto-removed if unchanged) | `--worktree` or `isolation: worktree` in the role: `<repo>/.claude/worktrees/codex-N` on branch `worktree-codex-N`; removed after a turn that changed nothing, recreated on the next `send` |
| `isolation: "remote"` | `--remote --env ENV_ID [--branch B]` → Codex Cloud task, polled until done, diff in the report. Codex Cloud cannot steer, continue or cancel: `send` is refused, `stop` only stops watching |

Codex has no interactive user: questions it asks mid-turn are answered with "decide or ask in your final message", and are listed in the report. If a turn ends with a question, answer it with `send`.

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
