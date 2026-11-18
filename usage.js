// Subscription usage limits, for the Account page's Usage section.
//
// Claude Code reports them in its stream-json output as `rate_limit_event`s:
//   { rate_limit_info: { status, rateLimitType, resetsAt, unifiedWindows: { five_hour: { utilization, resetsAt, status }, seven_day: {...} } } }
// Codex doesn't put them in `exec --json`, but writes them to its own session log
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) as `token_count` events:
//   { rate_limits: { primary: { used_percent, window_minutes, resets_at }, secondary: {...} } }
// Neither needs the tools' login tokens. A snapshot is
//   { at, windows: [{ id, label, percent, resetsAt, limited }] }
// with percent 0-100 and times in milliseconds.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLAUDE_LABELS = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly limit (Opus)',
  seven_day_sonnet: 'Weekly limit (Sonnet)',
};

const prettyId = (id) => {
  const words = String(id).replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} limit`;
};

/** A Claude Code `rate_limit_event`, as a snapshot, or null. */
function fromClaudeEvent(ev) {
  const info = ev?.type === 'rate_limit_event' ? ev.rate_limit_info : null;
  if (!info) return null;
  const windows = [];
  for (const [id, w] of Object.entries(info.unifiedWindows || {})) {
    if (!w || typeof w.utilization !== 'number') continue;
    windows.push({
      id,
      label: CLAUDE_LABELS[id] || prettyId(id),
      percent: Math.max(0, Math.min(100, Math.round(w.utilization * 100))),
      resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
      limited: w.status === 'rejected',
    });
  }
  // Older events carry only the binding window, without a utilization figure.
  if (!windows.length && info.rateLimitType) {
    windows.push({
      id: info.rateLimitType,
      label: CLAUDE_LABELS[info.rateLimitType] || prettyId(info.rateLimitType),
      percent: info.status === 'rejected' ? 100 : null,
      resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
      limited: info.status === 'rejected',
    });
  }
  return windows.length ? { at: Date.now(), windows } : null;
}

/** Merge a new snapshot into the last one: events can carry only the windows that changed. */
function merge(previous, next) {
  if (!next) return previous || null;
  const byId = new Map((previous?.windows || []).map((w) => [w.id, w]));
  for (const w of next.windows) byId.set(w.id, w);
  const order = ['five_hour', 'primary', 'seven_day', 'secondary'];
  const windows = [...byId.values()].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { at: next.at, windows };
}

const minutesLabel = (minutes) => {
  if (minutes === 10080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
};

function fromCodexLimits(limits, at) {
  const windows = [];
  for (const id of ['primary', 'secondary']) {
    const w = limits?.[id];
    if (!w || typeof w.used_percent !== 'number') continue;
    windows.push({
      id,
      label: w.window_minutes ? minutesLabel(w.window_minutes) : id === 'primary' ? '5-hour limit' : 'Weekly limit',
      percent: Math.max(0, Math.min(100, Math.round(w.used_percent))),
      resetsAt: w.resets_at ? w.resets_at * 1000 : null,
      limited: w.used_percent >= 100,
    });
  }
  return windows.length ? { at, windows } : null;
}

/** The newest file under Codex's sessions folder (year/month/day/rollout-*.jsonl). */
function newestCodexLog() {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let dir = root;
  for (let depth = 0; depth < 3; depth += 1) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort();
    } catch {
      return null;
    }
    if (!names.length) return null;
    dir = path.join(dir, names[names.length - 1]);
  }
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch {
    return null;
  }
}

/** Codex's latest reported limits, from the end of its newest session log, or null. */
function readCodexUsage() {
  const newest = newestCodexLog();
  if (!newest) return null;
  let text;
  try {
    const { size } = fs.statSync(newest.file);
    const fd = fs.openSync(newest.file, 'r');
    const length = Math.min(size, 512 * 1024); // the tail is enough: limits come with each turn
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    text = buffer.toString('utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const limits = entry.payload?.rate_limits || entry.rate_limits || entry.msg?.rate_limits;
      const at = entry.timestamp ? Date.parse(entry.timestamp) || newest.mtime : newest.mtime;
      const snapshot = fromCodexLimits(limits, at);
      if (snapshot) return snapshot;
    } catch {
      /* a partial first line from the tail read */
    }
  }
  return null;
}

module.exports = { fromClaudeEvent, readCodexUsage, merge };
