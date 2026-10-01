# codex-subagent

[English](#english) · [中文](#中文)

---

## English

A Claude Code skill that runs **OpenAI Codex as a subagent**. Claude hands a task to a Codex thread and drives it the way it drives its own subagents: start it in the background, get notified when it finishes, steer it while it works, continue it later, list it, stop it.

It is a single dependency-free Node script that talks to `codex app-server` over JSON-RPC, plus a `SKILL.md` that tells Claude how to use it.

### What it does

| Claude subagent | codex-subagent |
|---|---|
| `Agent(...)` in the background | `start`, run as a background Bash task; the task exiting is the completion notification |
| Final report | Codex's final message verbatim, plus files changed and worktree state |
| `SendMessage` to a running agent | `send` → inserted into the running turn immediately (`turn/steer`) |
| `SendMessage` to a finished agent | `send` → a new turn in the same Codex thread, context kept |
| `ListAgents` | `list` |
| `TaskStop` | `TaskStop` on the background task, or `stop` |
| Agent types (`.claude/agents`) | roles (`.claude/codex-agents/*.md`), which can extend a Claude agent definition |
| `isolation: "worktree"` | `--worktree`; removed again if the turn changed nothing |
| Permission mode of the session | `--mode` maps Claude's mode to a Codex sandbox and approval policy |
| Permission prompts surfacing in the main session | Codex's approval requests arrive as events; Claude answers with `approve` / `deny` and asks the user when it cannot decide |
| Subagent messages to main | Codex runs `notify`; Claude sees it through `watch` |

Also: model and reasoning effort per subagent (`--model`, `--effort`), a built-in read-only `reviewer` role, progress log and raw transcript per subagent, and recovery of a subagent after its host process was stopped or crashed.

### Requirements

- macOS (the only platform it has been tested on)
- Node.js 18 or newer (developed on 24)
- Codex CLI with `codex app-server`, signed in. The ChatGPT desktop app's bundled CLI is used when present, otherwise `codex` on `PATH`; set `CODEX_BIN` to choose another
- Claude Code

### Install

```bash
git clone <REPO_URL> ~/.claude/skills/codex-subagent
```

Check it:

```bash
node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles
```

Claude Code picks the skill up in new sessions. To update, `git pull` in that directory.

**Or paste this to your agent:**

> Install the codex-subagent skill: clone `<REPO_URL>` into `~/.claude/skills/codex-subagent`, check that Node.js and the Codex CLI are installed and signed in (`codex login status`), run `node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles` to confirm it works, and tell me the result.

### Use

Ask Claude in plain words, for example "have Codex fix this in a worktree" or "get a Codex review of this branch". Claude follows `SKILL.md`. The commands it uses:

```
start [--name N] [--description D] [--role R] [--worktree] [--mode M] [--model M] [--effort E]  PROMPT
send <name> MESSAGE          steer the running turn, or continue in a new turn
stop <name>                  interrupt the running turn
approve <name> <n>           grant approval request n
deny <name> <n> --reason …   refuse it; Codex gets the reason
list                         subagents of this Claude session
status | log | result | transcript <name>
watch <name>                 event stream for Claude's Monitor tool; begins with events not shown yet
roles                        available roles
rm <name>                    delete a subagent's state
```

### Permissions

`--mode` takes Claude Code's permission mode:

| Mode | Codex sandbox | Codex asks for approval |
|---|---|---|
| `bypassPermissions` | none | never |
| `auto`, `acceptEdits` | writes only in its working directory, no network | when it needs more |
| `default` | read-only | for every change |
| `plan`, `dontAsk` | read-only | never |

Without `--mode` a subagent uses the role's settings, else your Codex configuration, and never asks.

### Where things live

- State: `~/.claude/codex-subagents/<claude session id>/<name>/` (config, prompts, progress log, events, transcript). Names are per Claude session; another session's subagent is addressed as `<session id prefix>/<name>`
- Roles: `<repo>/.claude/codex-agents/`, `~/.claude/codex-agents/`, and `roles/` in this repository
- Worktrees: `<repo>/.claude/worktrees/codex-<name>` on branch `worktree-codex-<name>`

### Limits

- A subagent does not appear in Claude's own `ListAgents`; use `list`
- An approval request nobody answers blocks Codex until it is answered, so Claude must keep `watch` attached in modes where Codex can ask
- With `auto` / `acceptEdits`, Codex keeps `.git` read-only: every `git add` / `git commit` is an approval request
- `--remote` (Codex Cloud) is implemented but untested

---

## 中文

一个 Claude Code skill，让 Claude 把 **OpenAI Codex 当作 subagent** 来用。Claude 把任务交给一条 Codex 线程，然后像操作自己的 subagent 一样操作它：后台启动、完成时收到通知、运行中途插话、之后续跑、列出、停止。

它由两部分组成：一个不依赖第三方包的 Node 脚本，通过 JSON-RPC 驱动 `codex app-server`；一份 `SKILL.md`，告诉 Claude 怎么用。

### 功能

| Claude subagent | codex-subagent |
|---|---|
| 后台运行的 `Agent(...)` | `start`，作为后台 Bash 任务运行；任务退出就是完成通知 |
| 最终汇报 | Codex 最终回复的原文，加上改动的文件和 worktree 状态 |
| 给运行中的 agent 发 `SendMessage` | `send`，立刻插入正在执行的这一轮（`turn/steer`） |
| 给已结束的 agent 发 `SendMessage` | `send`，在同一条 Codex 线程里开新一轮，上下文保留 |
| `ListAgents` | `list` |
| `TaskStop` | 对后台任务用 `TaskStop`，或者用 `stop` |
| agent 类型（`.claude/agents`） | 角色（`.claude/codex-agents/*.md`），可以继承 Claude 的 agent 定义 |
| `isolation: "worktree"` | `--worktree`；这一轮没有改动时自动删除 |
| 会话的权限模式 | `--mode` 把 Claude 的模式对应到 Codex 的沙箱和审批策略 |
| 权限请求弹到主会话 | Codex 的审批请求以事件形式送达；Claude 用 `approve` / `deny` 答复，拿不准时问用户 |
| subagent 给 main 发消息 | Codex 运行 `notify`；Claude 通过 `watch` 收到 |

另外还支持：为每个 subagent 指定模型和推理强度（`--model`、`--effort`）、内置只读的 `reviewer` 角色、每个 subagent 的进度日志和原始记录、宿主进程被停止或崩溃后恢复 subagent。

### 环境要求

- macOS（目前只在 macOS 上测试过）
- Node.js 18 或更新版本（开发时用的是 24）
- 带 `codex app-server` 的 Codex CLI，并且已登录。优先使用 ChatGPT 桌面版自带的 CLI，没有时用 `PATH` 里的 `codex`；可以用环境变量 `CODEX_BIN` 指定
- Claude Code

### 安装

```bash
git clone <REPO_URL> ~/.claude/skills/codex-subagent
```

验证：

```bash
node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles
```

新开的 Claude Code 会话会自动加载这个 skill。更新时在该目录下 `git pull`。

**或者把这句话复制给你的 Agent：**

> 帮我安装 codex-subagent skill：把 `<REPO_URL>` 克隆到 `~/.claude/skills/codex-subagent`，检查 Node.js 和 Codex CLI 是否已安装并登录（`codex login status`），运行 `node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles` 确认能用，然后把结果告诉我。

### 使用

直接用自然语言告诉 Claude，比如"让 Codex 在 worktree 里修这个问题"或者"让 Codex 审一下这个分支"。Claude 会按 `SKILL.md` 操作。它用到的命令：

```
start [--name N] [--description D] [--role R] [--worktree] [--mode M] [--model M] [--effort E]  任务
send <名字> 消息             运行中插话，或者在新的一轮里续跑
stop <名字>                  中断正在执行的这一轮
approve <名字> <编号>        批准第 n 条审批请求
deny <名字> <编号> --reason … 拒绝，理由会传给 Codex
list                         当前 Claude 会话的 subagent
status | log | result | transcript <名字>
watch <名字>                 事件流，配合 Claude 的 Monitor 工具使用；从还没输出过的事件开始
roles                        可用的角色
rm <名字>                    删除一个 subagent 的状态
```

### 权限

`--mode` 的取值是 Claude Code 的权限模式：

| 模式 | Codex 沙箱 | Codex 何时申请批准 |
|---|---|---|
| `bypassPermissions` | 无 | 从不 |
| `auto`、`acceptEdits` | 只能写工作目录，不能联网 | 需要更多权限时 |
| `default` | 只读 | 每次要改东西时 |
| `plan`、`dontAsk` | 只读 | 从不 |

不传 `--mode` 时，subagent 使用角色里的设置；角色没有设置就用你的 Codex 配置，并且从不申请。

### 文件位置

- 状态：`~/.claude/codex-subagents/<Claude 会话 id>/<名字>/`（配置、任务原文、进度日志、事件、原始记录）。名字按 Claude 会话隔离；操作别的会话的 subagent 要写成 `<会话 id 前缀>/<名字>`
- 角色：`<仓库>/.claude/codex-agents/`、`~/.claude/codex-agents/`，以及本仓库的 `roles/`
- worktree：`<仓库>/.claude/worktrees/codex-<名字>`，分支 `worktree-codex-<名字>`

### 限制

- subagent 不会出现在 Claude 自己的 `ListAgents` 里，要用 `list` 查看
- 审批请求没人答复时，Codex 会一直等着。所以在 Codex 可能申请的模式下，Claude 必须一直挂着 `watch`
- `auto` / `acceptEdits` 模式下 Codex 会保护 `.git`，每次 `git add` / `git commit` 都是一条审批请求
- `--remote`（Codex Cloud）已实现，但没有测试过
