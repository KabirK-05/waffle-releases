// Subscription-billed providers. Instead of handling OAuth tokens itself, Waffle drives the
// official command-line tools, which keep their own sign-in:
//   claude  Claude Code, signed in with a Claude Pro/Max account (`claude auth login`)
//   codex   OpenAI Codex CLI, signed in with a ChatGPT account (`codex login`)
// Waffle never reads or stores either tool's credentials.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('./usage');

const CLI = { claude: 'claude', chatgpt: 'codex' };

// Called with (provider, snapshot) whenever a tool reports its plan's usage limits (usage.js).
let usageListener = null;
const onUsage = (fn) => {
  usageListener = fn;
};
const reportUsage = (provider, snapshot) => snapshot && usageListener?.(provider, snapshot);
const LOGIN_ARGS = { claude: ['auth', 'login', '--claudeai'], chatgpt: ['login'] };
const INSTALL_HINT = {
  claude: 'Install Claude Code first: curl -fsSL https://claude.ai/install.sh | bash',
  chatgpt: 'Install the Codex CLI first: brew install --cask codex (or npm i -g @openai/codex)',
};

let shellEnv = null; // PATH from the user's login shell, so Finder launches still find the CLIs
const cliPaths = {};

function loginShellPath() {
  if (shellEnv) return Promise.resolve(shellEnv);
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__WAFFLE__%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const found = !err && String(stdout).split('__WAFFLE__')[1];
      const extra = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin'];
      shellEnv = [found || process.env.PATH || '', ...extra].filter(Boolean).join(':');
      resolve(shellEnv);
    });
  });
}

async function env() {
  return { ...process.env, PATH: await loginShellPath(), NO_COLOR: '1' };
}

async function findCli(provider) {
  const name = CLI[provider];
  if (cliPaths[name] && fs.existsSync(cliPaths[name])) return cliPaths[name];
  const dirs = (await loginShellPath()).split(':');
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cliPaths[name] = candidate;
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function run(file, args, { timeout = 15000, cwd } = {}) {
  return env().then(
    (e) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout, env: e, cwd: cwd || os.homedir() }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
        );
      }),
  );
}

/** Returns { installed, signedIn, detail } for one provider. */
async function status(provider) {
  const cli = await findCli(provider);
  if (!cli) return { installed: false, signedIn: false, detail: INSTALL_HINT[provider] };

  if (provider === 'claude') {
    const { stdout } = await run(cli, ['auth', 'status', '--json']);
    let info = {};
    try {
      info = JSON.parse(stdout);
    } catch {
      /* older versions print text */
    }
    if (!info.loggedIn) return { installed: true, signedIn: false, detail: 'Not signed in.' };
    if (info.authMethod && info.authMethod !== 'claude.ai') {
      return { installed: true, signedIn: false, detail: `Claude Code is signed in with ${info.authMethod}, not a Claude subscription.` };
    }
    const plan = info.subscriptionType ? ` (${info.subscriptionType})` : '';
    const who = info.email ? ` as ${info.email}` : '';
    // email and plan feed the Account page's Connected accounts row.
    return { installed: true, signedIn: true, detail: `Signed in${who}${plan}.`, email: info.email || '', plan: info.subscriptionType || '' };
  }

  const { code, stdout, stderr } = await run(cli, ['login', 'status']);
  const text = `${stdout}\n${stderr}`.trim();
  if (code !== 0 || /not logged in/i.test(text)) return { installed: true, signedIn: false, detail: 'Not signed in.' };
  if (!/chatgpt/i.test(text)) {
    return { installed: true, signedIn: false, detail: 'Codex is signed in with an API key, not a ChatGPT account.' };
  }
  return { installed: true, signedIn: true, detail: 'Signed in with your ChatGPT account.' };
}

/**
 * Open Terminal running the tool's own sign-in command. A .command file runs in Terminal
 * without needing Automation permission, and any interactive prompts work there.
 */
async function openLogin(provider, workDir, openPath) {
  const cli = await findCli(provider);
  if (!cli) throw new Error(INSTALL_HINT[provider]);
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const script = path.join(workDir, `waffle-signin-${provider}.command`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    script,
    [
      '#!/bin/zsh -l',
      `${quote(cli)} ${LOGIN_ARGS[provider].join(' ')}`,
      'echo',
      'echo "Done. You can close this window and return to Waffle."',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  const err = await openPath(script);
  if (err) throw new Error(err);
}

// Claude Code has no command that lists models, so these are the current ones. Each was checked
// against `claude -p --model <id>`; the same IDs work with an API key.
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Most capable' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Fast and capable' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'Fastest' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', description: '' },
];

let codexModels = null;

/** Models to offer for a provider: [{ id, label, description }]. */
async function listModels(provider) {
  if (provider === 'claude') return CLAUDE_MODELS;
  if (codexModels) return codexModels;
  const cli = await findCli(provider);
  if (!cli) return [];
  // The Codex CLI prints the model catalog for the signed-in account.
  const { code, stdout } = await run(cli, ['debug', 'models'], { timeout: 15000 });
  if (code !== 0) return [];
  try {
    const models = (JSON.parse(stdout).models || [])
      .filter((m) => m.visibility === 'list' && (m.input_modalities || []).includes('image'))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: String(m.slug), label: String(m.display_name || m.slug), description: String(m.description || '') }));
    if (models.length) codexModels = models;
    return models;
  } catch {
    return [];
  }
}

/** The model Codex uses when none is chosen, from ~/.codex/config.toml. */
function codexDefaultModel() {
  try {
    const config = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const top = config.split(/^\[/m)[0]; // only the top-level keys, before any [table]
    return top.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '';
  } catch {
    return '';
  }
}

// ---------- streaming ----------

/** Fold earlier turns into text, since the CLIs take one prompt per run. */
function historyText(history) {
  const lines = [];
  for (const message of history) {
    const text = (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.length ? `Earlier in this conversation (screenshots omitted):\n\n${lines.join('\n\n')}\n\n---\n\n` : '';
}

function looksSignedOut(text) {
  return /not (logged|signed) in|please (run|log ?in)|\/login|authenticat|unauthori[sz]ed|401|invalid.*token|expired/i.test(text);
}

class CliError extends Error {
  constructor(message, { needsSignIn = false } = {}) {
    super(message);
    this.needsSignIn = needsSignIn;
  }
}

/** Read newline-delimited JSON from a child's stdout. */
function onJsonLines(stream, handler) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handler(JSON.parse(line));
      } catch {
        /* ignore non-JSON lines */
      }
    }
  });
}

// ---------- Claude: one live Claude Code process per conversation ----------

/**
 * A long-lived `claude -p` process fed one user message per turn over stream-json stdin. It
 * keeps the whole conversation, screenshots included, so follow-ups need no re-sent history and
 * pay no start-up cost. After each answer Claude Code runs a short summary step of its own; a
 * follow-up sent during it simply waits for it to finish.
 */
class ClaudeSession {
  constructor({ cli, args, env, cwd, key, conversation }) {
    this.key = key;
    this.conversation = conversation;
    this.turns = 0; // user turns this process has received (or been primed with as text)
    this.sentDocuments = false; // the mode's PDFs go with this process's first message
    this.turn = null; // the turn being answered, if any
    this.dead = false;
    this.stderr = '';
    this.requestId = 0;
    this.child = spawn(cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    onJsonLines(this.child.stdout, (ev) => this.handle(ev));
    this.child.on('error', (err) => this.exited(`Could not start claude: ${err.message}`));
    this.child.on('close', (code) => this.exited(this.stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`));
  }

  handle(ev) {
    if (ev.type === 'rate_limit_event') reportUsage('claude', usage.fromClaudeEvent(ev));
    const turn = this.turn;
    if (!turn) return; // e.g. the summary step after an answer, or the tail of a stopped turn
    // Events before this turn's `init` belong to the previous turn's summary step.
    if (ev.type === 'system' && ev.subtype === 'init') turn.started = true;
    if (!turn.started) return;
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') turn.emit(e.delta.text);
      if (e?.type === 'message_delta' && e.delta?.stop_reason) turn.stopReason = e.delta.stop_reason;
      // The answer is complete here; don't wait for the summary step or for the process.
      if (e?.type === 'message_stop') this.settle(null);
    } else if (ev.type === 'result') {
      if (ev.is_error) this.settle(String(ev.result || ev.subtype || 'Claude Code returned an error.'));
      else {
        if (!turn.text && ev.result) turn.emit(String(ev.result));
        this.settle(null);
      }
    }
  }

  settle(error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (error) {
      const needsSignIn = looksSignedOut(error);
      turn.reject(new CliError(needsSignIn ? 'Claude sign-in needed. Sign in again in Settings.' : error, { needsSignIn }));
    } else {
      turn.resolve({ text: turn.text, truncated: turn.stopReason === 'max_tokens', refused: turn.stopReason === 'refusal' });
    }
  }

  exited(message) {
    if (this.dead) return;
    this.dead = true;
    if (this.turn) this.settle(message);
  }

  send(content, onDelta) {
    const turn = { text: '', started: false, stopReason: null };
    turn.emit = (chunk) => {
      if (!chunk) return;
      turn.text += chunk;
      onDelta(chunk);
    };
    const done = new Promise((resolve, reject) => Object.assign(turn, { resolve, reject }));
    this.turn = turn;
    this.turns += 1;
    this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
    return {
      // Interrupt rather than kill, so the conversation survives a Stop.
      abort: () => {
        if (this.turn !== turn) return;
        this.turn = null;
        this.control({ subtype: 'interrupt' });
        turn.reject(Object.assign(new CliError('Stopped'), { aborted: true }));
      },
      done,
    };
  }

  control(request) {
    if (this.dead) return;
    this.requestId += 1;
    this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `waffle-${this.requestId}`, request })}\n`);
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    this.turn = null;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}

let claudeSession = null;

function claudeArgs({ system, model, effort }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--safe-mode', // no CLAUDE.md, hooks, plugins or MCP servers: just the model
    '--disable-slash-commands',
    '--no-session-persistence',
    '--effort', effort,
  ];
  if (model) args.push('--model', model);
  return args;
}

/** Start (or keep) a Claude Code process for this conversation and settings. */
async function ensureClaudeSession({ system, model, effort, workDir, conversation }) {
  const cli = await findCli('claude');
  if (!cli) throw new CliError(INSTALL_HINT.claude, { needsSignIn: true });
  const key = JSON.stringify([cli, system, model, effort]);
  const s = claudeSession;
  if (s && !s.dead && s.key === key && s.conversation === conversation) return s;
  s?.close();
  fs.mkdirSync(workDir, { recursive: true });
  claudeSession = new ClaudeSession({ cli, args: claudeArgs({ system, model, effort }), env: await env(), cwd: workDir, key, conversation });
  return claudeSession;
}

/** Start the process ahead of the first question, so it is already running when you ask. */
async function prewarmClaude(options) {
  try {
    const s = await ensureClaudeSession(options);
    return Boolean(s && !s.dead);
  } catch {
    return false;
  }
}

/** End the live Claude Code process (new chat, quit). */
function closeClaude() {
  claudeSession?.close();
  claudeSession = null;
}

async function claudeTurn({ system, documents = [], history, prompt, imageBase64, model, effort, workDir, onDelta, conversation, turnIndex }) {
  const session = await ensureClaudeSession({ system, model, effort, workDir, conversation });
  // A process that has not seen this conversation's earlier turns (settings changed, or it
  // crashed) gets them once as text. Screenshots from those turns can't be carried over.
  let text = prompt;
  if (session.turns !== turnIndex) {
    text = historyText(history) + prompt;
    session.turns = turnIndex;
  }
  const content = [];
  // The process keeps earlier messages, so the mode's PDFs are sent once, with its first message.
  // Their names are in the system prompt, so a different set of files means a new process.
  if (!session.sentDocuments) {
    for (const doc of documents) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 }, title: doc.name });
    }
    session.sentDocuments = true;
  }
  if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } });
  content.push({ type: 'text', text });
  return session.send(content, onDelta);
}

// ---------- Codex: one process per question ----------

/**
 * Start one answer. Returns { abort(), done } where done resolves to
 * { text, truncated, refused } or rejects with a CliError. Text arrives through onDelta.
 */
async function startStream(provider, options) {
  if (provider === 'claude') return claudeTurn(options);
  const { system, documents = [], history, prompt, imageBase64, model, effort, workDir, onDelta } = options;
  const cli = await findCli(provider);
  if (!cli) throw new CliError(INSTALL_HINT[provider], { needsSignIn: true });
  fs.mkdirSync(workDir, { recursive: true });

  let imageFile = null;
  const fullPrompt = historyText(history) + prompt;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', `model_reasoning_effort="${effort}"`,
  ];
  if (model) args.push('--model', model);
  args.push('-'); // prompt from stdin
  if (imageBase64) {
    imageFile = path.join(workDir, `screen-${Date.now()}.png`);
    fs.writeFileSync(imageFile, Buffer.from(imageBase64, 'base64'), { mode: 0o600 });
    args.push('--image', imageFile); // last, because --image accepts several values
  }
  // Codex can't take PDFs as input, but it can read files in its working folder (read-only).
  let documentNote = '';
  if (documents.length) {
    const refDir = path.join(workDir, 'references');
    fs.rmSync(refDir, { recursive: true, force: true });
    fs.mkdirSync(refDir, { recursive: true, mode: 0o700 });
    const names = documents.map((doc, i) => {
      const safe = `${i + 1}-${path.basename(doc.name).replace(/[^\w.\- ]/g, '_')}`;
      fs.copyFileSync(doc.path, path.join(refDir, safe));
      return `references/${safe}`;
    });
    documentNote = `\n\nThe mode's PDF reference files are in the working folder: ${names.join(', ')}. Read them if the question needs them.`;
  }
  const stdin = `${system}${documentNote}\n\n${fullPrompt}`;

  const child = spawn(cli, args, { cwd: workDir, env: await env(), stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  child.on('close', () => running.delete(child));
  let aborted = false;
  let text = '';
  let stderr = '';
  let result = null; // { error? }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const emit = (chunk) => {
    if (!chunk) return;
    text += chunk;
    onDelta(chunk);
  };

  let lastMessage = '';
  onJsonLines(child.stdout, (ev) => {
    // Current format: thread/turn/item events.
    const item = ev.item;
    if (item && (item.type === 'agent_message' || item.item_type === 'assistant_message')) {
      const full = String(item.text || '');
      if (lastMessage && full.startsWith(lastMessage)) emit(full.slice(lastMessage.length));
      else emit(`${text ? '\n\n' : ''}${full}`);
      lastMessage = ev.type === 'item.completed' ? '' : full;
    }
    if (ev.type === 'turn.failed') result = { ...result, error: String(ev.error?.message || 'Codex turn failed.') };
    if (ev.type === 'error' && ev.message) result = { ...result, error: String(ev.message) };
    // Older format: { msg: { type, ... } }.
    const msg = ev.msg;
    if (msg?.type === 'agent_message_delta') emit(msg.delta);
    if (msg?.type === 'agent_message' && !text) emit(msg.message);
    if (msg?.type === 'error') result = { ...result, error: String(msg.message) };
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new CliError(`Could not start ${CLI[provider]}: ${err.message}`)));
    child.on('close', (code) => {
      if (imageFile) fs.rm(imageFile, { force: true }, () => {});
      reportUsage('chatgpt', usage.readCodexUsage()); // Codex logs its limits, not stdout
      if (aborted) return reject(Object.assign(new CliError('Stopped'), { aborted: true }));
      const problem = result?.error || (code !== 0 ? stderr.trim().split('\n').slice(-3).join(' ') || `${CLI[provider]} exited with code ${code}` : '');
      if (problem) {
        const needsSignIn = looksSignedOut(problem);
        return reject(new CliError(needsSignIn ? 'ChatGPT sign-in needed. Sign in again in Settings.' : problem, { needsSignIn }));
      }
      resolve({ text, truncated: false, refused: false });
    });
  });

  child.stdin.on('error', () => {}); // the child may exit before reading everything
  child.stdin.end(stdin);

  return {
    abort() {
      aborted = true;
      child.kill('SIGTERM');
    },
    done,
  };
}

const running = new Set(); // Codex processes still going

/**
 * One answer with no conversation around it (used for session summaries). Runs its own process,
 * so it never touches the live chat's Claude Code process. Resolves to the full text.
 */
async function complete(provider, { system, prompt, model, effort, workDir, timeout = 180000 }) {
  if (provider === 'chatgpt') {
    const handle = await startStream('chatgpt', { system, history: [], prompt, model, effort, workDir, onDelta: () => {} });
    const timer = setTimeout(() => handle.abort(), timeout);
    try {
      return (await handle.done).text;
    } finally {
      clearTimeout(timer);
    }
  }
  const cli = await findCli('claude');
  if (!cli) throw new CliError(INSTALL_HINT.claude, { needsSignIn: true });
  fs.mkdirSync(workDir, { recursive: true });
  const args = claudeArgs({ system, model, effort }).filter(
    (arg, i, all) => !['--input-format', '--output-format', '--include-partial-messages', '--verbose'].includes(arg) && !['--input-format', '--output-format'].includes(all[i - 1]),
  );
  args.push('--output-format', 'json');
  const child = spawn(cli, args, { cwd: workDir, env: await env(), stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new CliError(`Could not start claude: ${err.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch {
        /* reported below */
      }
      if (result && !result.is_error && typeof result.result === 'string') return resolve(result.result);
      const problem = (result && String(result.result || '')) || stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`;
      const needsSignIn = looksSignedOut(problem);
      reject(new CliError(needsSignIn ? 'Claude sign-in needed. Sign in again in Settings.' : problem, { needsSignIn }));
    });
  });
}

/** Stop every CLI process Waffle started (on quit). */
function shutdown() {
  closeClaude();
  for (const child of running) child.kill('SIGTERM');
  running.clear();
}

module.exports = { status, openLogin, startStream, complete, prewarmClaude, closeClaude, shutdown, listModels, codexDefaultModel, onUsage, CliError };
