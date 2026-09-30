#!/usr/bin/env node
// codex-subagent — run Codex threads as subagents of a Claude Code session.
//
// A "host" process owns one Codex thread while a turn runs: it starts `codex app-server`, drives the
// thread over JSON-RPC and listens on a unix socket for control requests (steer / stop). It is meant
// to run as a Claude Code background task, so the task exiting is the completion notification and
// TaskStop (SIGTERM to the task's process group) interrupts the turn. Agent state lives in
// ~/.claude/codex-subagents/<name>/. See ../SKILL.md for the interface.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SELF), "..");
const HOME = process.env.CODEX_SUBAGENT_HOME ?? path.join(os.homedir(), ".claude", "codex-subagents");
const APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const SESSION = process.env.CLAUDE_CODE_SESSION_ID ?? null;
const TO_MAIN = "[[codex-subagent:to-main]]";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const EXIT = { completed: 0, failed: 1, stopped: 0 }; // a stop is requested, not a failure
const NO_USER_ANSWER =
  "No interactive user is available. Decide yourself if you reasonably can and say what you assumed; " +
  "otherwise finish the turn and put the question in your final message for the coordinator.";

// ---------- small helpers ----------

function die(msg, code = 2) {
  process.stderr.write(`codex-subagent: ${msg}\n`);
  process.exit(code);
}
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
const ago = (iso) => (iso ? `${fmtDur(Date.now() - Date.parse(iso))} ago` : "-");
const codexBin = () => process.env.CODEX_BIN ?? (fs.existsSync(APP_CODEX) ? APP_CODEX : "codex");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function parseArgs(argv, { values = [], flags = [], alias = {} } = {}) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-")) {
      pos.push(a);
      continue;
    }
    let key = a.replace(/^--?/, "");
    let val;
    const eq = key.indexOf("=");
    if (eq >= 0) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    key = alias[key] ?? key;
    if (flags.includes(key)) opts[key] = true;
    else if (values.includes(key)) {
      if (val === undefined) val = argv[++i];
      if (val === undefined) die(`--${key} needs a value`);
      opts[key] = val;
    } else die(`unknown option ${a}`);
  }
  return { opts, pos };
}

// Text from positional words, a file, or stdin ("-" or nothing with piped stdin).
function readText(words, file) {
  if (file) return fs.readFileSync(file, "utf8");
  if (words.length && !(words.length === 1 && words[0] === "-")) return words.join(" ");
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8");
}

// ---------- agent state ----------

function paths(name) {
  const dir = path.join(HOME, name);
  return {
    dir,
    agent: path.join(dir, "agent.json"),
    lock: path.join(dir, "host.json"),
    sock: path.join(dir, "ctl.sock"),
    transcript: path.join(dir, "transcript.jsonl"),
    events: path.join(dir, "events.jsonl"),
    progress: path.join(dir, "progress.log"),
    result: path.join(dir, "result.md"),
    serverLog: path.join(dir, "app-server.log"),
    prompts: path.join(dir, "prompts"),
  };
}
function loadAgent(name) {
  if (!name) die("missing subagent name");
  const a = readJson(paths(name).agent);
  if (!a) die(`no codex subagent named "${name}" (see: list --all)`);
  return a;
}
function saveAgent(a) {
  a.updatedAt = now();
  writeJsonAtomic(paths(a.name).agent, a);
}
function allAgents() {
  if (!fs.existsSync(HOME)) return [];
  return fs
    .readdirSync(HOME)
    .map((n) => readJson(path.join(HOME, n, "agent.json")))
    .filter(Boolean)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}
function note(name, kind, text) {
  const p = paths(name);
  const t = new Date();
  fs.appendFileSync(p.progress, `${t.toTimeString().slice(0, 8)} ${text}\n`);
  fs.appendFileSync(p.events, `${JSON.stringify({ t: t.toISOString(), kind, text })}\n`);
}
function savePrompt(name, label, text) {
  const dir = paths(name).prompts;
  const n = fs.readdirSync(dir).length + 1;
  fs.writeFileSync(path.join(dir, `${String(n).padStart(3, "0")}-${label}.md`), text);
}

// One host per agent. The lock file names the holder; a holder that is gone, or that neither answers
// on the control socket nor is still starting up, is stale.
async function acquireLock(name, waitMs = 0) {
  const p = paths(name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const held = readJson(p.lock);
    const young = held && Date.now() - Date.parse(held.startedAt) < 30_000;
    const stale = !held || !pidAlive(held.pid) || (!young && !(await control(name, { op: "ping" }, 2000)));
    if (stale) {
      fs.rmSync(p.lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}
function releaseLock(name) {
  const p = paths(name);
  if (readJson(p.lock)?.pid === process.pid) fs.rmSync(p.lock, { force: true });
}

// Request/response over the host's control socket; null when no host answers.
function control(name, req, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(paths(name).sock);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (d) => (buf += d));
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ---------- roles (the counterpart of .claude/agents) ----------

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: m[2].trim() };
}
function roleDirs(repoRoot) {
  return [
    repoRoot && path.join(repoRoot, ".claude", "codex-agents"),
    path.join(os.homedir(), ".claude", "codex-agents"),
    path.join(SKILL_DIR, "roles"),
  ].filter(Boolean);
}
function loadRole(name, repoRoot) {
  for (const d of roleDirs(repoRoot)) {
    const file = path.join(d, `${name}.md`);
    if (fs.existsSync(file)) return { name, file, ...parseFrontmatter(fs.readFileSync(file, "utf8")) };
  }
  die(`role "${name}" not found in: ${roleDirs(repoRoot).join(", ")}`);
}
// `extends: <agent>` reuses the body of a Claude agent definition as the role's base instructions.
function claudeAgentBody(name, repoRoot) {
  const dirs = [repoRoot && path.join(repoRoot, ".claude", "agents"), path.join(os.homedir(), ".claude", "agents")];
  for (const d of dirs.filter(Boolean)) {
    const file = path.join(d, `${name}.md`);
    if (fs.existsSync(file)) return parseFrontmatter(fs.readFileSync(file, "utf8")).body;
  }
  die(`extends: Claude agent "${name}" not found`);
}
function baseInstructions(name) {
  return [
    `You are running as a subagent named "${name}" of a Claude Code session (the coordinator).`,
    "- The final message of each turn is delivered verbatim to the coordinator as your report. Make it self-contained.",
    "- There is no interactive user. Do not wait for answers mid-turn. If you need a decision you cannot make yourself, finish the turn and state the question in your final message; the coordinator replies in a new turn.",
    "- Messages from the coordinator may be inserted while you work. Treat them as updated instructions.",
    `- To send the coordinator an interim message without ending the turn (an important finding, a blocker you are working around), run: node ${SELF} notify "<message>". Use it sparingly.`,
  ].join("\n");
}

// ---------- worktree isolation ----------

function ensureWorktree(a) {
  const wt = a.worktree;
  if (!wt.removed && fs.existsSync(wt.path)) return;
  const base = git(a.repoRoot, "rev-parse", "HEAD");
  if (!base.ok) die(`worktree: ${a.repoRoot} has no commits`, 1);
  git(a.repoRoot, "worktree", "prune");
  const r = git(a.repoRoot, "worktree", "add", "-B", wt.branch, wt.path, base.out);
  if (!r.ok) die(`git worktree add failed: ${r.err}`, 1);
  wt.base = base.out;
  wt.removed = false;
  a.cwd = wt.path;
}
// Like Claude's worktree isolation: a worktree the agent left untouched is removed.
function cleanupWorktreeIfUnchanged(a) {
  const wt = a.worktree;
  if (!wt || wt.removed || !fs.existsSync(wt.path)) return;
  const head = git(wt.path, "rev-parse", "HEAD").out;
  if (head !== wt.base || git(wt.path, "status", "--porcelain").out) return;
  if (git(a.repoRoot, "worktree", "remove", wt.path).ok) {
    git(a.repoRoot, "branch", "-D", wt.branch);
    wt.removed = true;
  }
}
// Files a turn changed, judged by git: commits made during the turn plus paths that became dirty.
function gitSnapshot(cwd) {
  const head = git(cwd, "rev-parse", "HEAD");
  if (!head.ok) return null;
  return { head: head.out, dirty: new Set(dirtyPaths(cwd)) };
}
function dirtyPaths(cwd) {
  return git(cwd, "status", "--porcelain", "--untracked-files=all")
    .out.split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ""));
}
function gitChangesSince(cwd, snap) {
  if (!snap) return [];
  const committed = git(cwd, "diff", "--name-only", snap.head, "HEAD").out.split("\n").filter(Boolean);
  return [...committed, ...dirtyPaths(cwd).filter((f) => !snap.dirty.has(f))];
}

function worktreeSummary(wt) {
  if (wt.removed) return "removed (no changes)";
  const ahead = git(wt.path, "rev-list", "--count", `${wt.base}..HEAD`).out;
  const dirty = git(wt.path, "status", "--porcelain").out ? "uncommitted changes" : "clean";
  return `${wt.path} · branch ${wt.branch} · ${ahead} commit(s) on top of ${wt.base.slice(0, 7)} · ${dirty}`;
}

// ---------- codex app-server client ----------

class AppServer {
  constructor(cwd, env, logFile) {
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.onRequest = async (method) => {
      throw Object.assign(new Error(`codex-subagent does not handle ${method}`), { code: -32601 });
    };
    // Same process group as the host: TaskStop's SIGTERM/SIGKILL reaches app-server too.
    this.proc = spawn(codexBin(), ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.pipe(fs.createWriteStream(logFile, { flags: "a" }));
    this.exited = new Promise((resolve) => {
      const fail = (err) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve(err);
      };
      this.proc.on("exit", (code, signal) => fail(new Error(`codex app-server exited (${signal ?? `code ${code}`})`)));
      this.proc.on("error", (e) => fail(new Error(`cannot start codex app-server (${codexBin()}): ${e.message}`)));
    });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.dispatch(line));
  }
  send(msg) {
    if (this.proc.stdin.writable) this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }
  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }
  dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      Promise.resolve()
        .then(() => this.onRequest(msg.method, msg.params ?? {}))
        .then(
          (result) => this.send({ id: msg.id, result }),
          (e) => this.send({ id: msg.id, error: { code: e.code ?? -32000, message: e.message } }),
        );
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }
  close() {
    try {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
    } catch {}
  }
}

const textInput = (text) => [{ type: "text", text, text_elements: [] }];

// ---------- host: owns the thread while turns run ----------

class Host {
  constructor(agent) {
    this.a = agent;
    this.p = paths(agent.name);
    this.turnId = null;
    this.turnActive = false;
    this.nextTurn = []; // coordinator messages that arrived when no turn could take them
    this.finishing = false;
    this.stopReason = null;
    this.usage = null;
    this.resetTurn();
  }
  resetTurn() {
    this.finalText = null;
    this.lastText = null;
    this.toMain = [];
    this.questions = [];
    this.changed = new Set();
    this.errorText = null;
    this.turnStartedAt = Date.now();
  }
  note(kind, text) {
    note(this.a.name, kind, text);
  }
  out(text) {
    process.stdout.write(`${text}\n`);
  }

  async run(text, { resume = false } = {}) {
    const a = this.a;
    this.done = new Promise((r) => (this.resolveDone = r));
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => this.onSignal(sig));
    if (a.worktree) ensureWorktree(a);
    a.status = "starting";
    a.hostPid = process.pid;
    saveAgent(a);

    const env = { ...process.env, CODEX_SUBAGENT_NAME: a.name };
    this.server = new AppServer(a.cwd, env, this.p.serverLog);
    this.server.onNotification = (m, p) => this.onNotification(m, p);
    this.server.onRequest = (m, p) => this.onRequest(m, p);
    this.server.exited.then((err) => {
      if (!this.finishing) this.fail(`${err.message}; see ${this.p.serverLog}`);
    });

    try {
      await this.server.request("initialize", { clientInfo: { name: "codex-subagent", title: "codex-subagent", version: "1" } });
      this.server.notify("initialized");
      const common = { cwd: a.cwd, approvalPolicy: "never", sandbox: a.sandbox, model: a.model };
      let res;
      if (resume) {
        res = await this.server.request("thread/resume", { threadId: a.threadId, ...common });
      } else {
        res = await this.server.request("thread/start", {
          ...common,
          developerInstructions: a.developerInstructions,
          ephemeral: false,
          serviceName: "codex-subagent",
        });
        a.threadId = res.thread.id;
        await this.server.request("thread/name/set", { threadId: a.threadId, name: `codex-subagent: ${a.name}` });
      }
      a.actual = { model: res.model, effort: res.reasoningEffort ?? null, sandbox: res.sandbox?.type ?? a.sandbox };
      await this.listen();
      this.out(
        `codex-subagent ${a.name}: ${resume ? "resumed" : "started"} · thread ${a.threadId} · ` +
          `${a.actual.model}${a.effort ?? a.actual.effort ? `/${a.effort ?? a.actual.effort}` : ""} · ` +
          `sandbox ${a.actual.sandbox ?? "default"} · ${a.cwd}`,
      );
      await this.startTurn(text, resume ? "message" : "task");
    } catch (e) {
      this.fail(e.message);
    }
    return this.done;
  }

  listen() {
    fs.rmSync(this.p.sock, { force: true });
    this.ctl = net.createServer((sock) => {
      sock.on("error", () => {});
      readline.createInterface({ input: sock }).once("line", async (line) => {
        let res;
        try {
          res = await this.handleControl(JSON.parse(line));
        } catch (e) {
          res = { ok: false, error: e.message };
        }
        sock.end(`${JSON.stringify(res)}\n`);
      });
    });
    return new Promise((resolve, reject) => this.ctl.once("error", reject).listen(this.p.sock, resolve));
  }

  async handleControl(req) {
    if (req.op === "ping") return { ok: true, status: this.a.status, turnActive: this.turnActive, pid: process.pid };
    if (this.finishing) return { ok: false, error: "finishing" };
    if (req.op === "stop") {
      this.requestStop(req.reason ?? "stop command");
      return { ok: true };
    }
    if (req.op === "send") {
      if (this.turnActive) {
        try {
          await this.server.request("turn/steer", {
            threadId: this.a.threadId,
            expectedTurnId: this.turnId,
            input: textInput(req.text),
          });
          savePrompt(this.a.name, "steer", req.text);
          this.note("steer", `⇢ coordinator (steered): ${oneLine(req.text)}`);
          return { ok: true, mode: "steer" };
        } catch (e) {
          this.note("steer", `⇢ steer rejected (${oneLine(e.message, 120)}); queued for the next turn`);
        }
      }
      this.nextTurn.push(req.text);
      return { ok: true, mode: "queued" };
    }
    return { ok: false, error: `unknown op ${req.op}` };
  }

  async startTurn(text, label) {
    const a = this.a;
    this.resetTurn();
    this.turnId = null;
    this.gitBefore = gitSnapshot(a.cwd);
    savePrompt(a.name, label, text);
    const res = await this.server.request("turn/start", {
      threadId: a.threadId,
      input: textInput(text),
      model: a.model,
      effort: a.effort,
    });
    // turn/started and even turn/completed can arrive before this response.
    if (this.finishing || a.turns.some((t) => t.id === res.turn.id)) return;
    this.turnId = res.turn.id;
    this.turnActive = res.turn.status === "inProgress";
    a.status = "running";
    a.lastActivityAt = now();
    saveAgent(a);
    this.note("turn-start", `▶ turn ${a.turns.length + 1} started (${label})`);
    // Messages that arrived while the turn was being created go in as steering.
    for (const t of this.nextTurn.splice(0)) await this.handleControl({ op: "send", text: t });
    if (!this.turnActive) this.onTurnCompleted(res.turn);
  }

  onNotification(method, p) {
    if (!/delta/i.test(method)) fs.appendFileSync(this.p.transcript, `${JSON.stringify({ t: now(), method, params: p })}\n`);
    const mine = p.threadId === this.a.threadId;
    switch (method) {
      case "turn/started":
        if (mine && !this.turnId) this.turnId = p.turn.id;
        break;
      case "item/completed":
        if (mine) this.onItem(p.item);
        break;
      case "thread/tokenUsage/updated":
        if (mine) this.usage = p.tokenUsage.total;
        break;
      case "error":
        if (mine) {
          this.note("error", `! ${oneLine(p.error.message, 300)}${p.willRetry ? " (retrying)" : ""}`);
          if (!p.willRetry) this.errorText = p.error.message;
        }
        break;
      case "turn/completed":
        if (mine && p.turn.id === this.turnId) this.onTurnCompleted(p.turn);
        break;
    }
  }

  onItem(item) {
    this.a.lastActivityAt = now();
    switch (item.type) {
      case "agentMessage":
        this.lastText = item.text;
        if (item.phase === "final_answer") this.finalText = item.text;
        else this.note("commentary", `» ${oneLine(item.text, 300)}`);
        break;
      case "commandExecution": {
        this.note("command", `$ ${oneLine(item.command, 160)} → ${item.exitCode ?? item.status}`);
        for (const line of String(item.aggregatedOutput ?? "").split("\n")) {
          if (!line.startsWith(TO_MAIN)) continue;
          const msg = line.slice(TO_MAIN.length).trim();
          this.toMain.push(msg);
          this.note("to-main", `✉ ${msg}`);
        }
        break;
      }
      case "fileChange":
        for (const c of item.changes ?? []) this.changed.add(path.relative(this.a.cwd, c.path) || c.path);
        this.note("file", `✎ ${(item.changes ?? []).map((c) => path.relative(this.a.cwd, c.path) || c.path).join(", ")}`);
        break;
      case "mcpToolCall":
        this.note("tool", `⚙ ${item.server}.${item.tool} → ${item.status}`);
        break;
      case "webSearch":
        this.note("tool", `⌕ ${oneLine(item.query, 120)}`);
        break;
      case "contextCompaction":
        this.note("tool", "⋯ context compacted");
        break;
    }
  }

  async onRequest(method, p) {
    if (method === "item/tool/requestUserInput") {
      const qs = p.questions ?? [];
      for (const q of qs) {
        this.questions.push(q.question);
        this.note("question", `? ${oneLine(q.question, 300)} (answered: no interactive user)`);
      }
      return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [NO_USER_ANSWER] }])) };
    }
    const declined = {
      "item/commandExecution/requestApproval": { decision: "decline" },
      "item/fileChange/requestApproval": { decision: "decline" },
      execCommandApproval: { decision: "denied" },
      applyPatchApproval: { decision: "denied" },
    }[method];
    if (declined) {
      // approvalPolicy is "never", so this should not happen; record it if it does.
      this.note("error", `! unexpected approval request ${method}; declined`);
      return declined;
    }
    throw Object.assign(new Error(`codex-subagent does not handle ${method}`), { code: -32601 });
  }

  onTurnCompleted(turn) {
    if (this.a.turns.some((t) => t.id === turn.id)) return;
    this.turnActive = false;
    const a = this.a;
    const status = turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "stopped";
    const errorText = turn.error?.message ?? this.errorText;
    a.turns.push({
      id: turn.id,
      startedAt: new Date(this.turnStartedAt).toISOString(),
      endedAt: now(),
      status,
      durationMs: turn.durationMs ?? Date.now() - this.turnStartedAt,
      error: errorText ?? undefined,
    });
    const final = this.finalText ?? this.lastText;
    fs.writeFileSync(this.p.result, final ?? "");
    this.note("turn-end", `■ turn ${a.turns.length} ${status}${errorText ? `: ${oneLine(errorText, 200)}` : ""}`);
    const continuing = status === "completed" && this.nextTurn.length > 0 && !this.stopReason;
    if (!continuing && a.worktree) cleanupWorktreeIfUnchanged(a);
    this.report(status, final, errorText);
    if (continuing) {
      this.startTurn(this.nextTurn.splice(0).join("\n\n"), "message").catch((e) => this.fail(e.message));
      return;
    }
    this.finish(status);
  }

  report(status, final, errorText) {
    const a = this.a;
    const turn = a.turns.at(-1);
    const u = this.usage;
    const tokens = u ? ` · ${u.totalTokens} tokens (in ${u.inputTokens}, out ${u.outputTokens})` : "";
    const lines = [
      "",
      `━━ codex-subagent ${a.name} · ${status}${this.stopReason ? ` (${this.stopReason})` : ""} · turn ${a.turns.length} · ${fmtDur(turn?.durationMs ?? 0)}${tokens} ━━`,
      final ?? "(no final message)",
    ];
    if (this.toMain.length) lines.push("", "── messages to main during this turn ──", ...this.toMain.map((m) => `- ${m}`));
    if (this.questions.length)
      lines.push("", "── questions Codex asked mid-turn (answered: no interactive user) ──", ...this.questions.map((q) => `- ${q}`));
    if (errorText) lines.push("", "── error ──", errorText);
    const changed = new Set([...this.changed, ...gitChangesSince(a.cwd, this.gitBefore)]);
    if (changed.size) lines.push("", "── files changed this turn ──", [...changed].join(", "));
    if (a.worktree) lines.push("", "── worktree ──", worktreeSummary(a.worktree));
    lines.push("", `(continue: node ${SELF} send ${a.name} - <<'EOF' … EOF  — run as a background task)`);
    this.out(lines.join("\n"));
  }

  requestStop(reason) {
    this.stopReason = reason;
    if (!this.turnActive) return this.finish("stopped");
    this.server.request("turn/interrupt", { threadId: this.a.threadId, turnId: this.turnId }).catch(() => {});
    // The interrupted turn ends with turn/completed; if app-server never says so, stop anyway and say why.
    setTimeout(() => {
      if (this.finishing) return;
      this.note("error", "! no turn/completed within 10s of turn/interrupt");
      this.finalizeStopped();
    }, 10_000).unref();
  }

  // TaskStop sends SIGTERM to the whole process group and SIGKILL ~1.5s later: record the stop now.
  onSignal(sig) {
    if (this.finishing) return;
    this.stopReason = `TaskStop/${sig}`;
    if (this.turnActive) this.server.request("turn/interrupt", { threadId: this.a.threadId, turnId: this.turnId }).catch(() => {});
    this.finalizeStopped();
  }

  finalizeStopped() {
    if (this.turnActive) {
      this.turnActive = false;
      this.a.turns.push({
        id: this.turnId,
        startedAt: new Date(this.turnStartedAt).toISOString(),
        endedAt: now(),
        status: "stopped",
        durationMs: Date.now() - this.turnStartedAt,
      });
      this.note("turn-end", `■ turn ${this.a.turns.length} stopped (${this.stopReason})`);
      fs.writeFileSync(this.p.result, this.finalText ?? this.lastText ?? "");
      if (this.a.worktree) cleanupWorktreeIfUnchanged(this.a);
      this.report("stopped", this.finalText ?? this.lastText, null);
    }
    this.finish("stopped");
  }

  fail(message) {
    if (this.finishing) return;
    this.errorText = message;
    this.note("error", `! ${oneLine(message, 300)}`);
    if (this.turnActive) {
      this.turnActive = false;
      this.a.turns.push({ id: this.turnId, startedAt: new Date(this.turnStartedAt).toISOString(), endedAt: now(), status: "failed", durationMs: Date.now() - this.turnStartedAt, error: message });
    }
    this.out(`\n━━ codex-subagent ${this.a.name} · failed ━━\n${message}`);
    this.finish("failed");
  }

  finish(status) {
    if (this.finishing) return;
    this.finishing = true;
    const a = this.a;
    a.status = status;
    a.hostPid = null;
    if (this.usage) a.usage = this.usage;
    saveAgent(a);
    this.note("host-exit", `□ host exited (${status})`);
    this.ctl?.close();
    fs.rmSync(this.p.sock, { force: true });
    releaseLock(a.name);
    this.server?.close();
    process.exitCode = EXIT[status];
    this.resolveDone(status);
    // Output is flushed by then; do not linger on app-server shutdown.
    setTimeout(() => process.exit(EXIT[status]), 300).unref();
  }
}

// ---------- remote (Codex Cloud) ----------
// Codex Cloud exposes submit / status / diff / apply only: no steering, no continuation, no cancel.

async function runRemote(a, text) {
  const branch = a.remote.branch ?? git(a.cwd, "rev-parse", "--abbrev-ref", "HEAD").out;
  savePrompt(a.name, "task", text);
  const sub = spawnSync(codexBin(), ["cloud", "exec", "--env", a.remote.env, "--branch", branch, text], { cwd: a.cwd, encoding: "utf8" });
  if (sub.status !== 0) {
    a.status = "failed";
    saveAgent(a);
    releaseLock(a.name);
    die(`codex cloud exec failed: ${oneLine(sub.stderr || sub.stdout, 500)}`, 1);
  }
  const id = sub.stdout.match(/\btask_[A-Za-z0-9_-]+/)?.[0] ?? sub.stdout.trim().split(/\s+/).at(-1);
  Object.assign(a.remote, { taskId: id, branch, submitOutput: sub.stdout.trim() });
  a.status = "running";
  a.hostPid = process.pid;
  saveAgent(a);
  note(a.name, "turn-start", `▶ submitted to Codex Cloud: ${id}`);
  console.log(`codex-subagent ${a.name}: submitted to Codex Cloud as ${id} (env ${a.remote.env}, branch ${branch})`);
  let stopped = null;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => (stopped = sig));
  let task = null;
  while (!stopped) {
    const list = spawnSync(codexBin(), ["cloud", "list", "--json", "--limit", "50"], { encoding: "utf8" });
    try {
      task = JSON.parse(list.stdout).tasks?.find((t) => t.id === id) ?? task;
    } catch {
      note(a.name, "error", `! codex cloud list: ${oneLine(list.stderr || list.stdout, 200)}`);
    }
    const st = String(task?.status ?? "").toLowerCase();
    if (st && !/pending|queued|running|progress/.test(st)) break;
    await sleep(30_000);
  }
  a.status = stopped ? "stopped" : /fail|error|cancel/.test(String(task?.status).toLowerCase()) ? "failed" : "completed";
  a.hostPid = null;
  saveAgent(a);
  releaseLock(a.name);
  if (stopped) {
    console.log(`\n━━ codex-subagent ${a.name} · stopped watching (${stopped}) ━━\nCodex Cloud has no cancel command; task ${id} keeps running there.`);
    process.exit(EXIT.stopped);
  }
  const diff = spawnSync(codexBin(), ["cloud", "diff", id], { encoding: "utf8" }).stdout ?? "";
  fs.writeFileSync(paths(a.name).result, JSON.stringify(task, null, 2));
  console.log(`\n━━ codex-subagent ${a.name} · ${a.status} (Codex Cloud ${id}) ━━\n${JSON.stringify(task, null, 2)}\n\n── diff (apply with: codex cloud apply ${id}) ──\n${diff.slice(0, 20_000)}`);
  process.exit(EXIT[a.status]);
}

// ---------- commands ----------

function autoName(hint) {
  const slug = String(hint).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return `${slug || "codex"}-${crypto.randomBytes(2).toString("hex")}`;
}

async function cmdStart(argv) {
  const { opts, pos } = parseArgs(argv, {
    values: ["name", "description", "role", "cwd", "sandbox", "model", "effort", "file", "env", "branch"],
    flags: ["worktree", "remote"],
  });
  const text = readText(pos, opts.file).trim();
  if (!text) die("empty prompt: pass it as text, with --file, or on stdin");
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const repoRoot = top.ok ? top.out : null;
  const role = opts.role ? loadRole(opts.role, repoRoot) : null;
  const name = opts.name ?? autoName(opts.description ?? role?.name ?? "codex");
  if (!NAME_RE.test(name)) die(`invalid name "${name}": use a-z, 0-9 and "-", at most 40 characters`);
  const sandbox = opts.sandbox ?? role?.meta.sandbox ?? null;
  if (sandbox && !SANDBOXES.includes(sandbox)) die(`--sandbox must be one of ${SANDBOXES.join(", ")}`);
  const wantWorktree = Boolean(opts.worktree) || role?.meta.isolation === "worktree";
  if (wantWorktree && !repoRoot) die("--worktree needs a git repository");
  if (opts.remote && !opts.env) die("--remote needs --env <Codex Cloud environment id>");

  fs.mkdirSync(HOME, { recursive: true });
  const p = paths(name);
  try {
    fs.mkdirSync(p.dir);
  } catch (e) {
    if (e.code === "EEXIST") die(`"${name}" already exists; continue it with send, or remove it with rm`);
    throw e;
  }
  fs.mkdirSync(p.prompts);
  const instructions = [
    baseInstructions(name),
    role?.meta.extends && claudeAgentBody(role.meta.extends, repoRoot),
    role?.body,
  ].filter(Boolean);
  const a = {
    name,
    description: opts.description ?? role?.meta.description ?? "",
    role: role?.name ?? null,
    cwd,
    repoRoot,
    sandbox,
    model: opts.model ?? role?.meta.model ?? null,
    effort: opts.effort ?? role?.meta.effort ?? null,
    developerInstructions: instructions.join("\n\n"),
    sessionId: SESSION,
    createdAt: now(),
    status: "starting",
    threadId: null,
    turns: [],
    worktree: wantWorktree
      ? { path: path.join(repoRoot, ".claude", "worktrees", `codex-${name}`), branch: `worktree-codex-${name}`, base: null, removed: true }
      : null,
    remote: opts.remote ? { env: opts.env, branch: opts.branch ?? null } : null,
  };
  saveAgent(a);
  await acquireLock(name);
  if (a.remote) return runRemote(a, text);
  return new Host(a).run(text);
}

async function cmdSend(argv) {
  const { opts, pos } = parseArgs(argv, { values: ["file"] });
  const [name, ...words] = pos;
  const a = loadAgent(name);
  const text = readText(words, opts.file).trim();
  if (!text) die("empty message");
  if (a.remote) die("remote (Codex Cloud) subagents cannot take messages: Codex Cloud cannot steer or continue a task");
  const r = await control(name, { op: "send", text }, 30_000);
  if (r?.ok) {
    console.log(
      r.mode === "steer"
        ? `delivered to ${name}: inserted into its running turn`
        : `queued for ${name}: it starts a new turn with this message when the current one ends`,
    );
    return;
  }
  // No host (or it is finishing): become the host and continue the thread in a new turn.
  if (!(await acquireLock(name, 30_000))) die(`${name} has a host that does not respond; try again or stop it`, 1);
  return new Host(loadAgent(name)).run(text, { resume: true });
}

async function cmdStop(argv) {
  const [name] = parseArgs(argv).pos;
  const a = loadAgent(name);
  if (a.remote && a.hostPid && pidAlive(a.hostPid)) {
    process.kill(a.hostPid, "SIGTERM");
    return console.log(`${name}: stopped watching; Codex Cloud has no cancel, the task keeps running there`);
  }
  const r = await control(name, { op: "stop", reason: "stop command" });
  if (!r?.ok) return console.log(`${name} is not running (${liveStatus(a, null)})`);
  for (let i = 0; i < 60 && fs.existsSync(paths(name).lock); i++) await sleep(250);
  console.log(`${name}: ${loadAgent(name).status}`);
}

function liveStatus(a, ping) {
  if (ping?.ok) return ping.turnActive ? "running" : "starting";
  if (["running", "starting"].includes(a.status)) return a.hostPid && pidAlive(a.hostPid) ? a.status : "stopped (host gone)";
  return a.status;
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : String(c).padEnd(w[i]))).join("  ")).join("\n");
}

async function cmdList(argv) {
  const { opts } = parseArgs(argv, { flags: ["all", "json"] });
  const agents = allAgents().filter((a) => opts.all || !SESSION || a.sessionId === SESSION);
  const rows = [];
  for (const a of agents) {
    const ping = a.hostPid ? await control(a.name, { op: "ping" }, 1500) : null;
    const status = liveStatus(a, ping);
    rows.push({
      name: a.name,
      status,
      role: a.role ?? "-",
      turns: a.turns.length + (status === "running" ? 1 : 0),
      started: ago(a.createdAt),
      lastActivity: ago(a.lastActivityAt ?? a.updatedAt),
      where: a.remote ? `cloud:${a.remote.taskId ?? "?"}` : a.worktree && !a.worktree.removed ? a.worktree.path : a.cwd,
      description: a.description,
    });
  }
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(opts.all ? "no codex subagents" : "no codex subagents in this session (list --all shows every session)");
  console.log(
    table([
      ["NAME", "STATUS", "ROLE", "TURNS", "STARTED", "LAST ACTIVITY", "WHERE", "DESCRIPTION"],
      ...rows.map((r) => [r.name, r.status, r.role, r.turns, r.started, r.lastActivity, r.where, r.description]),
    ]),
  );
}

async function cmdStatus(argv) {
  const [name] = parseArgs(argv).pos;
  const a = loadAgent(name);
  const ping = a.hostPid ? await control(name, { op: "ping" }, 1500) : null;
  const p = paths(name);
  const lines = [
    `name:        ${a.name}${a.description ? ` — ${a.description}` : ""}`,
    `status:      ${liveStatus(a, ping)}${a.hostPid ? ` (host pid ${a.hostPid})` : ""}`,
    `role:        ${a.role ?? "-"}`,
    `thread:      ${a.threadId ?? "-"}`,
    `model:       ${a.actual?.model ?? a.model ?? "default"} / effort ${a.effort ?? a.actual?.effort ?? "default"} / sandbox ${a.actual?.sandbox ?? a.sandbox ?? "default"}`,
    `cwd:         ${a.cwd}`,
  ];
  if (a.worktree) lines.push(`worktree:    ${worktreeSummary(a.worktree)}`);
  if (a.remote) lines.push(`remote:      Codex Cloud task ${a.remote.taskId ?? "?"} (env ${a.remote.env})`);
  lines.push(
    `turns:       ${a.turns.map((t) => `${t.status} ${fmtDur(t.durationMs)}`).join(", ") || "-"}`,
    `usage:       ${a.usage ? `${a.usage.totalTokens} tokens` : "-"}`,
    `created:     ${a.createdAt} (${ago(a.createdAt)})`,
    `files:       ${p.dir}`,
    "",
    "recent progress:",
    tail(p.progress, 12) || "(none)",
  );
  console.log(lines.join("\n"));
}

function tail(file, n) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n");
}

function cmdLog(argv) {
  const { opts, pos } = parseArgs(argv, { values: ["lines"], alias: { n: "lines" } });
  loadAgent(pos[0]);
  console.log(tail(paths(pos[0]).progress, Number(opts.lines ?? 40)) || "(no progress yet)");
}

function cmdResult(argv) {
  const [name] = parseArgs(argv).pos;
  loadAgent(name);
  const f = paths(name).result;
  console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(no result yet)");
}

function cmdTranscript(argv) {
  const [name] = parseArgs(argv).pos;
  loadAgent(name);
  console.log(paths(name).transcript);
}

// For the Monitor tool: one line per event worth interrupting the coordinator for; exits with the host.
async function cmdWatch(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ["verbose", "from-start"] });
  const name = pos[0];
  loadAgent(name);
  const p = paths(name);
  const kinds = new Set(["to-main", "question", "error", "turn-end", "host-exit"]);
  if (opts.verbose) for (const k of ["commentary", "command", "file", "tool", "steer", "turn-start"]) kinds.add(k);
  let offset = opts["from-start"] || !fs.existsSync(p.events) ? 0 : fs.statSync(p.events).size;
  let idle = 0;
  for (;;) {
    const size = fs.existsSync(p.events) ? fs.statSync(p.events).size : 0;
    if (size > offset) {
      const fd = fs.openSync(p.events, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const complete = text.lastIndexOf("\n") + 1;
      offset += Buffer.byteLength(text.slice(0, complete));
      for (const line of text.slice(0, complete).split("\n").filter(Boolean)) {
        const ev = JSON.parse(line);
        if (kinds.has(ev.kind)) console.log(`[${name}] ${ev.text}`);
        if (ev.kind === "host-exit") return;
      }
      idle = 0;
    } else if (!fs.existsSync(p.lock) && ++idle > 20) {
      return console.log(`[${name}] not running (${loadAgent(name).status})`);
    }
    await sleep(500);
  }
}

// Called by Codex from inside its shell; the host picks the line out of the command output.
function cmdNotify(argv) {
  const text = readText(parseArgs(argv).pos).trim();
  if (!text) die("empty message");
  console.log(`${TO_MAIN} ${oneLine(text, 2000)}`);
}

function cmdRoles() {
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  const seen = new Set();
  const rows = [["ROLE", "SANDBOX", "ISOLATION", "SOURCE", "DESCRIPTION"]];
  for (const d of roleDirs(top.ok ? top.out : null)) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md")).sort()) {
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(d, f), "utf8"));
      rows.push([name, meta.sandbox ?? "default", meta.isolation ?? "-", d.replace(os.homedir(), "~"), meta.description ?? ""]);
    }
  }
  console.log(table(rows));
}

async function cmdRm(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ["force"] });
  const a = loadAgent(pos[0]);
  if (await control(a.name, { op: "ping" }, 1500)) {
    if (!opts.force) die(`${a.name} is running; stop it first or use --force`);
    await cmdStop([a.name]);
  }
  if (a.worktree && !a.worktree.removed && fs.existsSync(a.worktree.path)) {
    cleanupWorktreeIfUnchanged(a);
    if (!a.worktree.removed) console.log(`kept worktree with changes: ${worktreeSummary(a.worktree)}`);
  }
  fs.rmSync(paths(a.name).dir, { recursive: true, force: true });
  console.log(`removed ${a.name}`);
}

const USAGE = `codex-subagent — Codex threads as Claude Code subagents

  start [--name N] [--description D] [--role R] [--worktree] [--cwd DIR]
        [--sandbox read-only|workspace-write|danger-full-access] [--model M] [--effort E]
        [--remote --env ENV_ID [--branch B]]  [PROMPT | - | --file F]
  send <name> [MESSAGE | - | --file F]     steer the running turn, or continue in a new turn
  stop <name>                              interrupt the running turn
  list [--all] [--json]                    subagents of this Claude session (or all)
  status <name>        log <name> [-n N]        result <name>        transcript <name>
  watch <name> [--verbose] [--from-start]  event stream for the Monitor tool
  notify MESSAGE                           (for Codex) interim message to the coordinator
  roles                rm <name> [--force]
`;

const commands = {
  start: cmdStart,
  send: cmdSend,
  stop: cmdStop,
  list: cmdList,
  status: cmdStatus,
  log: cmdLog,
  result: cmdResult,
  transcript: cmdTranscript,
  watch: cmdWatch,
  notify: cmdNotify,
  roles: cmdRoles,
  rm: cmdRm,
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  process.stdout.write(USAGE);
  process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0);
}
await commands[cmd](rest);
