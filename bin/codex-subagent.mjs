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
// `notify` prints this line; the host picks it out of the command's output. The id makes each message
// deliverable once, however often the line shows up again (a log that captured it and is printed later).
const TO_MAIN = "[[codex-subagent:to-main]]";
const TO_MAIN_RE = /^\[\[codex-subagent:to-main\]\] #([0-9a-f]{12}) (.*)$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"]; // narrowest first
const APPROVALS = ["untrusted", "on-request", "never"];
// Claude Code permission mode → the closest Codex sandbox and approval policy.
const MODES = {
  bypassPermissions: { sandbox: "danger-full-access", approval: "never" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
  acceptEdits: { sandbox: "workspace-write", approval: "on-request" },
  default: { sandbox: "read-only", approval: "on-request" },
  plan: { sandbox: "read-only", approval: "never" },
  dontAsk: { sandbox: "read-only", approval: "never" },
};
MODES.manual = MODES.default;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);
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
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
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

// Layout: HOME/<claude session id>/<name>/. A directory directly under HOME that holds an agent.json
// is the earlier flat layout: it is moved into place once no host runs in it and used in place until then.
const NO_SESSION = "no-session";
const sessionDir = (sessionId) => path.join(HOME, sessionId ?? NO_SESSION);
const isFlatDir = (dir) => path.dirname(dir) === HOME;

function paths(dir) {
  return {
    dir,
    agent: path.join(dir, "agent.json"),
    lock: path.join(dir, "host.json"),
    // <session id>/<name>/ctl.sock would exceed the ~100 byte limit of a socket path, so the socket gets a
    // short name of its own. A host started in a flat directory listens inside it.
    sock: isFlatDir(dir)
      ? path.join(dir, "ctl.sock")
      : path.join(HOME, ".sock", `${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 16)}.sock`),
    transcript: path.join(dir, "transcript.jsonl"),
    events: path.join(dir, "events.jsonl"),
    progress: path.join(dir, "progress.log"),
    result: path.join(dir, "result.md"),
    serverLog: path.join(dir, "app-server.log"),
    prompts: path.join(dir, "prompts"),
    cursor: path.join(dir, "watch.json"),
  };
}
// An agent carries the directory it was read from; it is not part of agent.json.
function readAgent(dir) {
  const a = readJson(path.join(dir, "agent.json"));
  return a ? Object.defineProperty(a, "dir", { value: dir, enumerable: false }) : null;
}
function hostAlive(dir) {
  const held = readJson(path.join(dir, "host.json"));
  return Boolean(held && pidAlive(held.pid));
}
function agentDirs() {
  if (!fs.existsSync(HOME)) return [];
  const dirs = [];
  for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(HOME, entry.name);
    if (fs.existsSync(path.join(dir, "agent.json"))) dirs.push(dir);
    else for (const sub of fs.readdirSync(dir)) dirs.push(path.join(dir, sub));
  }
  return dirs;
}
function allAgents() {
  return agentDirs()
    .map(readAgent)
    .filter(Boolean)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}
// Moves flat-layout agents to HOME/<their session id>/<name>. One with a running host is left alone:
// the host has the old paths in memory.
function migrateFlatLayout() {
  for (const dir of agentDirs().filter(isFlatDir)) {
    const a = readAgent(dir);
    if (!a || hostAlive(dir)) continue;
    const target = path.join(sessionDir(a.sessionId), a.name);
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(path.join(dir, "host.json"), { force: true });
      fs.rmSync(path.join(dir, "ctl.sock"), { force: true });
      fs.renameSync(dir, target);
    } catch (e) {
      if (!["ENOENT", "EACCES", "EPERM", "EROFS"].includes(e.code)) throw e; // moved by another invocation, or read-only here
    }
  }
}
// "name" is a subagent of this session; "<session id prefix>/name" is one of another session. A subagent
// still in the flat layout, where names were global, also answers to its bare name from any session.
function loadAgent(addr) {
  if (!addr) die("missing subagent name");
  const slash = addr.lastIndexOf("/");
  const [prefix, name] = slash >= 0 ? [addr.slice(0, slash), addr.slice(slash + 1)] : [null, addr];
  const sid = (a) => a.sessionId ?? NO_SESSION;
  const label = (a) => `${sid(a).slice(0, 8)}/${a.name}`;
  const named = allAgents().filter((a) => a.name === name);
  let hits;
  if (prefix === null) {
    hits = named.filter((a) => sid(a) === (SESSION ?? NO_SESSION));
    if (!hits.length) hits = named.filter((a) => isFlatDir(a.dir));
  } else {
    if (!prefix) die(`"${addr}": the session id prefix is empty`);
    hits = named.filter((a) => sid(a).startsWith(prefix));
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) die(`"${addr}" matches several subagents; use one of: ${hits.map(label).join(", ")}`);
  if (prefix === null && named.length) die(`no codex subagent named "${name}" in this session; other sessions have: ${named.map(label).join(", ")}`);
  die(`no codex subagent named "${addr}"`);
}
// The same subagent after a flat directory may have been moved to its session.
function reloadAgent(a) {
  return readAgent(a.dir) ?? readAgent(path.join(sessionDir(a.sessionId), a.name)) ?? die(`${a.name} is gone`, 1);
}
function saveAgent(a) {
  a.updatedAt = now();
  writeJsonAtomic(paths(a.dir).agent, a);
}
function note(a, kind, text, extra = {}) {
  const p = paths(a.dir);
  const t = new Date();
  fs.appendFileSync(p.progress, `${t.toTimeString().slice(0, 8)} ${text}\n`);
  fs.appendFileSync(p.events, `${JSON.stringify({ t: t.toISOString(), kind, text, ...extra })}\n`);
}
// Ids of the notify messages already delivered for this subagent, in any earlier turn or host.
function deliveredNotifyIds(a) {
  const ids = new Set();
  const file = paths(a.dir).events;
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"kind":"to-main"')) continue;
    const id = JSON.parse(line).id;
    if (id) ids.add(id);
  }
  return ids;
}
function savePrompt(a, label, text) {
  const dir = paths(a.dir).prompts;
  const n = fs.readdirSync(dir).length + 1;
  fs.writeFileSync(path.join(dir, `${String(n).padStart(3, "0")}-${label}.md`), text);
}

// One host per agent. The lock file names the holder; a holder that is gone, or that neither answers
// on the control socket nor is still starting up, is stale.
async function acquireLock(a, waitMs = 0) {
  const p = paths(a.dir);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false; // the directory was moved (layout migration) while we waited
      if (e.code !== "EEXIST") throw e;
    }
    const held = readJson(p.lock);
    const young = held && Date.now() - Date.parse(held.startedAt) < 30_000;
    const stale = !held || !pidAlive(held.pid) || (!young && !(await control(a, { op: "ping" }, 2000)));
    if (stale) {
      fs.rmSync(p.lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}
function releaseLock(a) {
  const p = paths(a.dir);
  if (readJson(p.lock)?.pid === process.pid) fs.rmSync(p.lock, { force: true });
}

// Request/response over the host's control socket; null when no host answers.
function control(a, req, timeoutMs = 3000) {
  return controlAt(paths(a.dir).sock, req, timeoutMs);
}
function controlAt(sockPath, req, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
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
function baseInstructions(name, approval) {
  return [
    `You are running as a subagent named "${name}" of a Claude Code session (the coordinator).`,
    "- The final message of each turn is delivered verbatim to the coordinator as your report. Make it self-contained.",
    "- There is no interactive user. Do not wait for answers mid-turn. If you need a decision you cannot make yourself, finish the turn and state the question in your final message; the coordinator replies in a new turn.",
    "- Messages from the coordinator may be inserted while you work. Treat them as updated instructions.",
    `- To send the coordinator an interim message without ending the turn (an important finding, a blocker you are working around), run: node ${SELF} notify "<message>". Use it sparingly.`,
    approval !== "never" &&
      "- Actions your sandbox does not allow need the coordinator's approval. Request them with a specific justification instead of working around the sandbox; a denial may come with a reason — follow it.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- permissions ----------

// Flags win. Otherwise a role may narrow what the mode allows, never widen it.
function resolvePermissions(mode, rolePerms, opts) {
  if (mode && !MODES[mode]) die(`--mode must be one of ${Object.keys(MODES).join(", ")}`);
  const m = mode ? MODES[mode] : null;
  const narrower = (x, y) => (!x ? y : !y ? x : SANDBOXES.indexOf(x) <= SANDBOXES.indexOf(y) ? x : y);
  const sandbox = opts.sandbox ?? narrower(rolePerms?.sandbox, m?.sandbox) ?? null;
  const approval = opts.approval ?? rolePerms?.approval ?? m?.approval ?? "never";
  if (sandbox && !SANDBOXES.includes(sandbox)) die(`sandbox must be one of ${SANDBOXES.join(", ")}`);
  if (!APPROVALS.includes(approval)) die(`approval must be one of ${APPROVALS.join(", ")}`);
  return { sandbox, approval };
}

// What Codex is asking for, in one line. `items` holds the fileChange items seen so far.
function describeApproval(method, p, items) {
  const why = p.reason ? ` · reason: ${oneLine(p.reason, 300)}` : "";
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const net = p.networkApprovalContext?.host ? ` · network: ${p.networkApprovalContext.host}` : "";
      return `command \`${oneLine(p.command, 400)}\` in ${p.cwd ?? "?"}${net}${why}`;
    }
    case "execCommandApproval":
      return `command \`${oneLine([].concat(p.command ?? []).join(" "), 400)}\` in ${p.cwd ?? "?"}${why}`;
    case "item/fileChange/requestApproval": {
      const changes = items.get(p.itemId)?.changes ?? [];
      const files = changes.map((c) => `${c.kind?.type ?? "change"} ${c.path}`).join(", ") || "(files not reported)";
      return `file changes: ${oneLine(files, 600)}${p.grantRoot ? ` · write access under ${p.grantRoot}` : ""}${why}`;
    }
    case "applyPatchApproval":
      return `file changes: ${oneLine(Object.keys(p.fileChanges ?? {}).join(", "), 600)}${p.grantRoot ? ` · write access under ${p.grantRoot}` : ""}${why}`;
    case "item/permissions/requestApproval":
      return `additional permissions ${JSON.stringify(p.permissions)} in ${p.cwd}${why}`;
  }
  return method;
}

// decision: approve | approve-session | deny | cancel (deny and interrupt the turn)
function approvalResponse(method, p, decision) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: { approve: "accept", "approve-session": "acceptForSession", deny: "decline", cancel: "cancel" }[decision] };
    case "item/permissions/requestApproval":
      return {
        permissions: decision.startsWith("approve") ? p.permissions : {},
        scope: decision === "approve-session" ? "session" : "turn",
      };
    default:
      return { decision: { approve: "approved", "approve-session": "approved_for_session", deny: "denied", cancel: "abort" }[decision] };
  }
}

// ---------- worktree isolation ----------

const branchExists = (repoRoot, branch) => git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;
// Names are per session, worktrees per repository: a second subagent of the same name gets a suffix.
function newWorktree(repoRoot, name) {
  for (const suffix of ["", `-${crypto.randomBytes(2).toString("hex")}`]) {
    const id = `codex-${name}${suffix}`;
    const wt = { path: path.join(repoRoot, ".claude", "worktrees", id), branch: `worktree-${id}`, base: null, removed: true };
    if (!fs.existsSync(wt.path) && !branchExists(repoRoot, wt.branch)) return wt;
  }
  die(`cannot find a free worktree name for "${name}" in ${repoRoot}`);
}
function ensureWorktree(a) {
  const wt = a.worktree;
  if (!wt.removed && fs.existsSync(wt.path)) return;
  const base = git(a.repoRoot, "rev-parse", "HEAD");
  if (!base.ok) die(`worktree: ${a.repoRoot} has no commits`, 1);
  git(a.repoRoot, "worktree", "prune");
  // A branch that is still there (its worktree directory was removed by hand) keeps its commits.
  const kept = branchExists(a.repoRoot, wt.branch);
  const r = kept
    ? git(a.repoRoot, "worktree", "add", wt.path, wt.branch)
    : git(a.repoRoot, "worktree", "add", "-b", wt.branch, wt.path, base.out);
  if (!r.ok) die(`git worktree add failed: ${r.err}`, 1);
  if (!kept || !wt.base) wt.base = base.out;
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
  constructor(cwd, env, logFile, extraArgs = []) {
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.onRequest = async (method) => {
      throw Object.assign(new Error(`codex-subagent does not handle ${method}`), { code: -32601 });
    };
    // Same process group as the host: TaskStop's SIGTERM/SIGKILL reaches app-server too.
    this.proc = spawn(codexBin(), ["app-server", ...extraArgs], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
        .then(() => this.onRequest(msg.method, msg.params ?? {}, msg.id))
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
    this.p = paths(agent.dir);
    this.turnId = null;
    this.turnActive = false;
    this.nextTurn = []; // coordinator messages that arrived when no turn could take them
    this.finishing = false;
    this.stopReason = null;
    this.usage = null;
    this.notified = deliveredNotifyIds(agent);
    this.outBuf = new Map(); // unfinished last line of each running command's output
    this.pending = new Map(); // approval requests waiting for the coordinator, by number
    this.items = new Map(); // fileChange items, to describe what an approval is about
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
  note(kind, text, extra) {
    note(this.a, kind, text, extra);
  }
  // A notify message is delivered the first time its id is seen, whichever way it arrives.
  deliverNotify(id, text) {
    if (this.notified.has(id)) return;
    this.notified.add(id);
    this.toMain.push(text);
    this.note("to-main", `✉ ${text}`, { id });
  }
  scanOutputLine(line) {
    const m = TO_MAIN_RE.exec(line.replace(/\r$/, ""));
    if (m) this.deliverNotify(m[1], m[2]);
  }
  out(text) {
    process.stdout.write(`${text}\n`);
  }

  async run(text, { resume = false } = {}) {
    const a = this.a;
    this.done = new Promise((r) => (this.resolveDone = r));
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => this.onSignal(sig));
    for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => this.crash(e));
    if (a.worktree) ensureWorktree(a);
    a.status = "starting";
    a.hostPid = process.pid;
    saveAgent(a);

    const env = { ...process.env, CODEX_SUBAGENT_NAME: a.name, CODEX_SUBAGENT_SOCK: this.p.sock };
    // Unless allowed, a Codex subagent does not spawn agents of its own: the coordinator decides who runs.
    // agents.enabled is what removes the spawn_agent tools (the multi_agent feature flags do not); the
    // override applies to this app-server process only, not to other Codex instances or the user's config.
    const noSubagents = a.allowSubagents ? [] : ["-c", "agents.enabled=false"];
    this.server = new AppServer(a.cwd, env, this.p.serverLog, noSubagents);
    this.server.onNotification = (m, p) => this.onNotification(m, p);
    this.server.onRequest = (m, p, id) => this.onRequest(m, p, id);
    this.server.exited.then((err) => {
      if (!this.finishing) this.fail(`${err.message}; see ${this.p.serverLog}`);
    });

    try {
      await this.server.request("initialize", { clientInfo: { name: "codex-subagent", title: "codex-subagent", version: "1" } });
      this.server.notify("initialized");
      const common = { cwd: a.cwd, approvalPolicy: a.approval ?? "never", sandbox: a.sandbox, model: a.model };
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
          `sandbox ${a.actual.sandbox ?? "default"} · approval ${a.approval ?? "never"}${a.allowSubagents ? " · may spawn sub-agents" : ""} · ${a.cwd}`,
      );
      await this.startTurn(text, resume ? "message" : "task");
    } catch (e) {
      this.fail(e.message);
    }
    return this.done;
  }

  listen() {
    fs.mkdirSync(path.dirname(this.p.sock), { recursive: true });
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
    const pending = [...this.pending.values()].map((r) => ({ id: r.id, text: r.text }));
    if (req.op === "ping") return { ok: true, status: this.a.status, turnActive: this.turnActive, pid: process.pid, pending: pending.length };
    if (req.op === "pending") return { ok: true, pending };
    if (req.op === "notify") {
      this.deliverNotify(req.id, req.text);
      return { ok: true };
    }
    if (this.finishing) return { ok: false, error: "finishing" };
    if (req.op === "answer") return this.answer(req);
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
          savePrompt(this.a, "steer", req.text);
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

  async answer({ id, decision, reason }) {
    const r = this.pending.get(Number(id));
    if (!r) return { ok: false, error: `no pending approval #${id} (already answered, or the turn moved on)` };
    this.pending.delete(r.id);
    r.resolve(approvalResponse(r.method, r.params, decision));
    this.note("approval-answer", `${decision.startsWith("approve") ? "✓" : "✗"} approval #${r.id} ${decision}${reason ? `: ${oneLine(reason, 300)}` : ""}`);
    if (reason && decision === "deny" && this.turnActive) {
      const text = `The coordinator denied your request (${r.text}). Reason: ${reason}`;
      await this.server
        .request("turn/steer", { threadId: this.a.threadId, expectedTurnId: this.turnId, input: textInput(text) })
        .catch((e) => this.note("error", `! could not deliver the denial reason: ${oneLine(e.message, 200)}`));
    }
    return { ok: true };
  }

  async startTurn(text, label) {
    const a = this.a;
    this.resetTurn();
    this.turnId = null;
    this.gitBefore = gitSnapshot(a.cwd);
    savePrompt(a, label, text);
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
      case "item/commandExecution/outputDelta": {
        // Deliver a notify as soon as it is printed, not when the command it is part of ends.
        if (!mine) break;
        const lines = ((this.outBuf.get(p.itemId) ?? "") + p.delta).split("\n");
        this.outBuf.set(p.itemId, lines.pop());
        for (const line of lines) this.scanOutputLine(line);
        break;
      }
      case "item/started":
        if (p.item?.type === "fileChange") this.items.set(p.item.id, p.item);
        break;
      case "item/completed":
        if (mine) this.onItem(p.item);
        break;
      case "serverRequest/resolved":
        for (const r of this.pending.values()) {
          if (r.rpcId !== p.requestId) continue;
          this.pending.delete(r.id);
          this.note("approval", `· approval #${r.id} is no longer needed (resolved by Codex)`);
        }
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
        this.outBuf.delete(item.id);
        for (const line of String(item.aggregatedOutput ?? "").split("\n")) this.scanOutputLine(line);
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

  async onRequest(method, p, rpcId) {
    if (method === "item/tool/requestUserInput") {
      const qs = p.questions ?? [];
      for (const q of qs) {
        this.questions.push(q.question);
        this.note("question", `? ${oneLine(q.question, 300)} (answered: no interactive user)`);
      }
      return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [NO_USER_ANSWER] }])) };
    }
    if (APPROVAL_METHODS.has(method)) {
      const id = (this.a.approvalSeq = (this.a.approvalSeq ?? 0) + 1);
      saveAgent(this.a);
      const text = describeApproval(method, p, this.items);
      return new Promise((resolve) => {
        this.pending.set(id, { id, rpcId, method, params: p, text, resolve });
        this.note("approval", `⚠ approval #${id} — ${text} → answer: approve ${this.a.name} ${id} | deny ${this.a.name} ${id} --reason "…"`);
      });
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
    this.pending.clear();
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

  // An error nothing handled, for example a log write on a full disk. Record as much of the failure as can
  // still be written — every step may fail for the same reason — then exit.
  crash(e) {
    if (this.crashing) process.exit(1);
    this.crashing = true;
    const attempt = (fn) => {
      try {
        fn();
      } catch {}
    };
    const message = `host crashed: ${e?.message ?? e}`;
    attempt(() => process.stderr.write(`${e?.stack ?? e}\n`));
    if (!this.finishing) {
      this.finishing = true;
      const a = this.a;
      if (this.turnActive) {
        a.turns.push({ id: this.turnId, startedAt: new Date(this.turnStartedAt).toISOString(), endedAt: now(), status: "failed", durationMs: Date.now() - this.turnStartedAt, error: message });
      }
      a.status = "failed";
      a.hostPid = null;
      attempt(() => saveAgent(a));
      attempt(() => note(a, "error", `! ${oneLine(message, 1000)}`));
      attempt(() => note(a, "host-exit", "□ host exited (failed)"));
      attempt(() => this.out(`\n━━ codex-subagent ${a.name} · failed ━━\n${message}`));
    }
    attempt(() => fs.rmSync(this.p.sock, { force: true }));
    attempt(() => releaseLock(this.a));
    attempt(() => this.server?.close());
    process.exit(1);
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
    releaseLock(a);
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
  savePrompt(a, "task", text);
  const sub = spawnSync(codexBin(), ["cloud", "exec", "--env", a.remote.env, "--branch", branch, text], { cwd: a.cwd, encoding: "utf8" });
  if (sub.status !== 0) {
    a.status = "failed";
    saveAgent(a);
    releaseLock(a);
    die(`codex cloud exec failed: ${oneLine(sub.stderr || sub.stdout, 500)}`, 1);
  }
  const id = sub.stdout.match(/\btask_[A-Za-z0-9_-]+/)?.[0] ?? sub.stdout.trim().split(/\s+/).at(-1);
  Object.assign(a.remote, { taskId: id, branch, submitOutput: sub.stdout.trim() });
  a.status = "running";
  a.hostPid = process.pid;
  saveAgent(a);
  note(a, "turn-start", `▶ submitted to Codex Cloud: ${id}`);
  console.log(`codex-subagent ${a.name}: submitted to Codex Cloud as ${id} (env ${a.remote.env}, branch ${branch})`);
  let stopped = null;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => (stopped = sig));
  let task = null;
  while (!stopped) {
    const list = spawnSync(codexBin(), ["cloud", "list", "--json", "--limit", "50"], { encoding: "utf8" });
    try {
      task = JSON.parse(list.stdout).tasks?.find((t) => t.id === id) ?? task;
    } catch {
      note(a, "error", `! codex cloud list: ${oneLine(list.stderr || list.stdout, 200)}`);
    }
    const st = String(task?.status ?? "").toLowerCase();
    if (st && !/pending|queued|running|progress/.test(st)) break;
    await sleep(30_000);
  }
  a.status = stopped ? "stopped" : /fail|error|cancel/.test(String(task?.status).toLowerCase()) ? "failed" : "completed";
  a.hostPid = null;
  saveAgent(a);
  releaseLock(a);
  if (stopped) {
    console.log(`\n━━ codex-subagent ${a.name} · stopped watching (${stopped}) ━━\nCodex Cloud has no cancel command; task ${id} keeps running there.`);
    process.exit(EXIT.stopped);
  }
  const diff = spawnSync(codexBin(), ["cloud", "diff", id], { encoding: "utf8" }).stdout ?? "";
  fs.writeFileSync(paths(a.dir).result, JSON.stringify(task, null, 2));
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
    values: ["name", "description", "role", "cwd", "mode", "sandbox", "approval", "model", "effort", "file", "env", "branch"],
    flags: ["worktree", "remote", "allow-subagents"],
  });
  const text = readText(pos, opts.file).trim();
  if (!text) die("empty prompt: pass it as text, with --file, or on stdin");
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const repoRoot = top.ok ? top.out : null;
  const role = opts.role ? loadRole(opts.role, repoRoot) : null;
  const name = opts.name ?? autoName(opts.description ?? role?.name ?? "codex");
  if (!NAME_RE.test(name)) die(`invalid name "${name}": use a-z, 0-9 and "-", at most 40 characters`);
  const rolePerms = { sandbox: role?.meta.sandbox ?? null, approval: role?.meta.approval ?? null };
  const perms = resolvePermissions(opts.mode, rolePerms, opts);
  const wantWorktree = Boolean(opts.worktree) || role?.meta.isolation === "worktree";
  if (wantWorktree && !repoRoot) die("--worktree needs a git repository");
  if (opts.remote && !opts.env) die("--remote needs --env <Codex Cloud environment id>");

  const exists = () => die(`"${name}" already exists in this session; continue it with send, or remove it with rm`);
  if (allAgents().some((x) => x.name === name && (x.sessionId ?? null) === SESSION)) exists();
  const dir = path.join(sessionDir(SESSION), name);
  fs.mkdirSync(sessionDir(SESSION), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code === "EEXIST") exists();
    throw e;
  }
  fs.mkdirSync(paths(dir).prompts);
  const instructions = [
    baseInstructions(name, perms.approval),
    role?.meta.extends && claudeAgentBody(role.meta.extends, repoRoot),
    role?.body,
  ].filter(Boolean);
  const a = {
    name,
    description: opts.description ?? role?.meta.description ?? "",
    role: role?.name ?? null,
    cwd,
    repoRoot,
    mode: opts.mode ?? null,
    allowSubagents: Boolean(opts["allow-subagents"]),
    rolePerms,
    ...perms,
    model: opts.model ?? role?.meta.model ?? null,
    effort: opts.effort ?? role?.meta.effort ?? null,
    developerInstructions: instructions.join("\n\n"),
    sessionId: SESSION,
    createdAt: now(),
    status: "starting",
    threadId: null,
    turns: [],
    worktree: wantWorktree ? newWorktree(repoRoot, name) : null,
    remote: opts.remote ? { env: opts.env, branch: opts.branch ?? null } : null,
  };
  Object.defineProperty(a, "dir", { value: dir, enumerable: false });
  saveAgent(a);
  await acquireLock(a);
  if (a.remote) return runRemote(a, text);
  return new Host(a).run(text);
}

async function cmdSend(argv) {
  const { opts, pos } = parseArgs(argv, { values: ["file", "mode", "sandbox", "approval"] });
  const [addr, ...words] = pos;
  const a = loadAgent(addr);
  const name = a.name;
  const text = readText(words, opts.file).trim();
  if (!text) die("empty message");
  const newPerms = opts.mode || opts.sandbox || opts.approval;
  if (a.remote) die("remote (Codex Cloud) subagents cannot take messages: Codex Cloud cannot steer or continue a task");
  const r = await control(a, { op: "send", text }, 30_000);
  if (r?.ok) {
    console.log(
      r.mode === "steer"
        ? `delivered to ${name}: inserted into its running turn`
        : `queued for ${name}: it starts a new turn with this message when the current one ends`,
    );
    if (newPerms) console.log("permissions unchanged: --mode/--sandbox/--approval only apply when send starts a new turn of an idle subagent");
    return;
  }
  // No host (or it is finishing): become the host and continue the thread in a new turn.
  for (let i = 0; i < 150 && hostAlive(a.dir); i++) await sleep(200);
  migrateFlatLayout(); // a host that just left a flat directory frees it to be moved
  const fresh = reloadAgent(a);
  if (!(await acquireLock(fresh, 30_000))) die(`${name} has a host that does not respond; try again or stop it`, 1);
  if (newPerms) {
    const mode = opts.mode ?? fresh.mode ?? null;
    Object.assign(fresh, { mode }, resolvePermissions(mode, fresh.rolePerms, opts));
  }
  return new Host(fresh).run(text, { resume: true });
}

async function cmdStop(argv) {
  const a = loadAgent(parseArgs(argv).pos[0]);
  const name = a.name;
  if (a.remote && a.hostPid && pidAlive(a.hostPid)) {
    process.kill(a.hostPid, "SIGTERM");
    return console.log(`${name}: stopped watching; Codex Cloud has no cancel, the task keeps running there`);
  }
  const r = await control(a, { op: "stop", reason: "stop command" });
  if (!r?.ok) return console.log(`${name} is not running (${liveStatus(a, null)})`);
  for (let i = 0; i < 60 && fs.existsSync(paths(a.dir).lock); i++) await sleep(250);
  console.log(`${name}: ${reloadAgent(a).status}`);
}

async function cmdAnswer(verb, argv) {
  const { opts, pos } = parseArgs(argv, { values: ["reason"], flags: ["session", "cancel"] });
  const a = loadAgent(pos[0]);
  const [name, id] = [a.name, pos[1]];
  if (!id) die(`usage: ${verb} <name> <approval number>`);
  const decision = verb === "approve" ? (opts.session ? "approve-session" : "approve") : opts.cancel ? "cancel" : "deny";
  const r = await control(a, { op: "answer", id, decision, reason: opts.reason }, 20_000);
  if (!r) die(`${name} is not running`, 1);
  if (!r.ok) die(r.error, 1);
  console.log(`${name}: approval #${id} → ${decision}`);
}

function liveStatus(a, ping) {
  if (ping?.ok && ping.pending) return `needs approval (${ping.pending})`;
  if (ping?.ok) return ping.turnActive ? "running" : "starting";
  if (["running", "starting"].includes(a.status)) return a.hostPid && pidAlive(a.hostPid) ? a.status : "stopped (host gone)";
  return a.status;
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : String(c).padEnd(w[i]))).join("  ")).join("\n");
}

async function cmdList(argv) {
  const { opts } = parseArgs(argv, { flags: ["json"] });
  const agents = allAgents().filter((a) => (a.sessionId ?? null) === SESSION);
  const rows = [];
  for (const a of agents) {
    const ping = a.hostPid ? await control(a, { op: "ping" }, 1500) : null;
    const status = liveStatus(a, ping);
    rows.push({
      name: a.name,
      status,
      role: a.role ?? "-",
      turns: a.turns.length + (/^(running|needs approval)/.test(status) ? 1 : 0),
      started: ago(a.createdAt),
      lastActivity: ago(a.lastActivityAt ?? a.updatedAt),
      where: a.remote ? `cloud:${a.remote.taskId ?? "?"}` : a.worktree && !a.worktree.removed ? a.worktree.path : a.cwd,
      description: a.description,
    });
  }
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("no codex subagents in this session");
  console.log(
    table([
      ["NAME", "STATUS", "ROLE", "TURNS", "STARTED", "LAST ACTIVITY", "WHERE", "DESCRIPTION"],
      ...rows.map((r) => [r.name, r.status, r.role, r.turns, r.started, r.lastActivity, r.where, r.description]),
    ]),
  );
}

async function cmdStatus(argv) {
  const a = loadAgent(parseArgs(argv).pos[0]);
  const ping = a.hostPid ? await control(a, { op: "ping" }, 1500) : null;
  const p = paths(a.dir);
  const lines = [
    `name:        ${a.name}${a.description ? ` — ${a.description}` : ""}`,
    `status:      ${liveStatus(a, ping)}${a.hostPid ? ` (host pid ${a.hostPid})` : ""}`,
    `session:     ${a.sessionId ?? NO_SESSION}`,
    `role:        ${a.role ?? "-"}`,
    `thread:      ${a.threadId ?? "-"}`,
    `model:       ${a.actual?.model ?? a.model ?? "default"} / effort ${a.effort ?? a.actual?.effort ?? "default"}`,
    `permissions: mode ${a.mode ?? "-"} → sandbox ${a.actual?.sandbox ?? a.sandbox ?? "default"}, approval ${a.approval ?? "never"}, sub-agents ${a.allowSubagents ? "allowed" : "off"}`,
    `cwd:         ${a.cwd}`,
  ];
  const pend = ping?.pending ? await control(a, { op: "pending" }, 1500) : null;
  for (const r of pend?.pending ?? []) lines.push(`pending:     #${r.id} ${r.text}`);
  if (a.worktree) lines.push(`worktree:    ${worktreeSummary(a.worktree)}`);
  if (a.remote) lines.push(`remote:      Codex Cloud task ${a.remote.taskId ?? "?"} (env ${a.remote.env})`);
  lines.push(
    `turns:       ${a.turns.map((t) => `${t.status} ${fmtDur(t.durationMs)}`).join(", ") || "-"}`,
    ...(a.turns.at(-1)?.error ? [`last error:  ${oneLine(a.turns.at(-1).error, 400)}`] : []),
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
  console.log(tail(paths(loadAgent(pos[0]).dir).progress, Number(opts.lines ?? 40)) || "(no progress yet)");
}

function cmdResult(argv) {
  const f = paths(loadAgent(parseArgs(argv).pos[0]).dir).result;
  console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(no result yet)");
}

function cmdTranscript(argv) {
  console.log(paths(loadAgent(parseArgs(argv).pos[0]).dir).transcript);
}

// For the Monitor tool: one line per event worth interrupting the coordinator for. It begins with the
// events no earlier watch has shown (the position is kept per subagent), then follows the host and ends
// when the host exits.
async function cmdWatch(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ["verbose", "from-start"] });
  const a = loadAgent(pos[0]);
  const name = a.name;
  const p = paths(a.dir);
  const kinds = new Set(["to-main", "question", "approval", "error", "turn-end", "host-exit"]);
  if (opts.verbose) for (const k of ["commentary", "command", "file", "tool", "steer", "turn-start", "approval-answer"]) kinds.add(k);
  let offset = opts["from-start"] ? 0 : (readJson(p.cursor)?.offset ?? 0);
  let last = null; // kind of the most recent event read
  const readNew = () => {
    const size = fs.existsSync(p.events) ? fs.statSync(p.events).size : 0;
    if (size <= offset) return [];
    const fd = fs.openSync(p.events, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const complete = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
    if (!complete.length) return [];
    const events = complete.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const ev of events) if (kinds.has(ev.kind)) console.log(`[${name}] ${ev.text}`);
    offset += complete.length;
    writeJsonAtomic(p.cursor, { offset });
    last = events.at(-1).kind;
    return events;
  };

  const backlog = readNew();
  // A request an earlier watch already showed and nobody answered yet is repeated.
  const pend = await control(a, { op: "pending" }, 1500);
  for (const r of pend?.pending ?? []) {
    if (backlog.some((ev) => ev.kind === "approval" && ev.text.startsWith(`⚠ approval #${r.id} `))) continue;
    console.log(`[${name}] ⚠ approval #${r.id} (still waiting) — ${r.text} → answer: approve ${name} ${r.id} | deny ${name} ${r.id} --reason "…"`);
  }
  for (let idle = 0; ; ) {
    await sleep(500);
    if (readNew().length) {
      if (last === "host-exit") return;
      idle = 0;
    } else if (!hostAlive(a.dir) && ++idle > 20) {
      // No host for 10 s: nothing to follow. Say so unless the backlog already ended with the host's exit.
      if (last !== "host-exit") console.log(`[${name}] not running (${readAgent(a.dir)?.status ?? "removed"})`);
      return;
    }
  }
}

// Called by Codex from inside its shell. The printed line is what gets out of a sandbox: the host finds it
// in the command's output, as it is printed or — for output in a command's first instant, which app-server
// does not stream — when the command ends. Where nothing blocks it, the host is also told directly, at once.
async function cmdNotify(argv) {
  const text = oneLine(readText(parseArgs(argv).pos), 2000);
  if (!text) die("empty message");
  const id = crypto.randomBytes(6).toString("hex");
  console.log(`${TO_MAIN} #${id} ${text}`);
  if (process.env.CODEX_SUBAGENT_SOCK) await controlAt(process.env.CODEX_SUBAGENT_SOCK, { op: "notify", id, text }, 2000);
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
  if (await control(a, { op: "ping" }, 1500)) {
    if (!opts.force) die(`${a.name} is running; stop it first or use --force`);
    await cmdStop([pos[0]]);
  }
  if (a.worktree && !a.worktree.removed && fs.existsSync(a.worktree.path)) {
    cleanupWorktreeIfUnchanged(a);
    if (!a.worktree.removed) console.log(`kept worktree with changes: ${worktreeSummary(a.worktree)}`);
  }
  fs.rmSync(paths(a.dir).sock, { force: true });
  fs.rmSync(a.dir, { recursive: true, force: true });
  if (!isFlatDir(a.dir) && fs.readdirSync(path.dirname(a.dir)).length === 0) fs.rmdirSync(path.dirname(a.dir));
  console.log(`removed ${a.name}`);
}

const USAGE = `codex-subagent — Codex threads as Claude Code subagents

  start [--name N] [--description D] [--role R] [--worktree] [--cwd DIR]
        [--mode bypassPermissions|auto|acceptEdits|default|plan|dontAsk]
        [--sandbox read-only|workspace-write|danger-full-access] [--approval untrusted|on-request|never]
        [--model M] [--effort E] [--allow-subagents]
        [--remote --env ENV_ID [--branch B]]  [PROMPT | - | --file F]
  send <name> [--mode M] [MESSAGE | - | --file F]   steer the running turn, or continue in a new turn
  stop <name>                              interrupt the running turn
  approve <name> <n> [--session]           grant approval request n (--session: also similar later ones)
  deny <name> <n> [--reason TEXT] [--cancel]   refuse it; the reason is passed to Codex (--cancel: also interrupt)
  list [--json]                            subagents of this Claude session
  <name> is a subagent of this session; <session id prefix>/<name> is one of another session.
  status <name>        log <name> [-n N]        result <name>        transcript <name>
  watch <name> [--verbose] [--from-start]  event stream for the Monitor tool; begins with events no watch has shown yet
  notify MESSAGE                           (for Codex) interim message to the coordinator
  roles                rm <name> [--force]
`;

const commands = {
  start: cmdStart,
  send: cmdSend,
  stop: cmdStop,
  approve: (argv) => cmdAnswer("approve", argv),
  deny: (argv) => cmdAnswer("deny", argv),
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
if (cmd !== "notify") migrateFlatLayout();
await commands[cmd](rest);
