# codex-subagent

[中文](#中文) · [English](#english)

---

## 中文

**想用 GPT 6 Astra 但无法忍受不讲人话？**

让 Claude Code 用 Codex 作为 Subagent。

转发原生 Codex CLI 消息，支持双向通信，无反代。

### 安装

需要 macOS、Node.js 18 以上、已登录的 Codex CLI（ChatGPT 桌面版自带的即可）和 Claude Code。

```bash
git clone <REPO_URL> ~/.claude/skills/codex-subagent
```

验证：

```bash
node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles
```

**或者把这句话复制给你的 Agent：**

> 帮我安装 codex-subagent skill：把 `<REPO_URL>` 克隆到 `~/.claude/skills/codex-subagent`，检查 Node.js 和 Codex CLI 是否已安装并登录（`codex login status`），运行 `node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles` 确认能用，然后把结果告诉我。

装好后新开一个 Claude Code 会话，直接说"让 Codex 来做这件事"。具体用法见 [SKILL.md](SKILL.md)。

---

## English

**Want GPT 6 Astra, but can't stand that it won't talk like a human?**

Let Claude Code use Codex as a subagent.

Relays native Codex CLI messages, two-way communication, no reverse proxy.

### Install

Requires macOS, Node.js 18 or newer, a signed-in Codex CLI (the one bundled with the ChatGPT desktop app works) and Claude Code.

```bash
git clone <REPO_URL> ~/.claude/skills/codex-subagent
```

Check it:

```bash
node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles
```

**Or paste this to your agent:**

> Install the codex-subagent skill: clone `<REPO_URL>` into `~/.claude/skills/codex-subagent`, check that Node.js and the Codex CLI are installed and signed in (`codex login status`), run `node ~/.claude/skills/codex-subagent/bin/codex-subagent.mjs roles` to confirm it works, and tell me the result.

Then open a new Claude Code session and say "have Codex do this". Details are in [SKILL.md](SKILL.md).
