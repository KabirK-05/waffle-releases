// Saved conversations and listening sessions, in a SQLite database in the user-data folder
// (owner-only permissions). Uses Node's built-in `node:sqlite`, so there is no native module to
// rebuild for Electron. Only text is stored: questions, answers and whether a screenshot was
// attached; for a listening session, its transcript and summary. Screenshots and audio are never
// written to disk.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_SESSIONS = 1000;
const MAX_ANSWER_CHARS = 20000;
const TITLE_CHARS = 64;
const LIST_LIMIT = 200;

/** A short, readable title: the first question, or else the answer's first sentence. */
function makeTitle(turn) {
  const plain = (text) =>
    String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*`#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  let title = plain(turn.question);
  if (!title) title = plain(turn.answer).split(/(?<=[.!?:])\s/)[0];
  if (!title) return 'Untitled session';
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1).trimEnd()}…` : title;
}

function createHistory(file) {
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      used_screen INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, id);
    CREATE INDEX IF NOT EXISTS sessions_by_update ON sessions(updated_at DESC);
  `);
  // Listening sessions share the table: kind 'meeting', with a summary and a JSON transcript.
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (!columns.has('kind')) db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
  if (!columns.has('summary')) db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  if (!columns.has('transcript')) db.exec("ALTER TABLE sessions ADD COLUMN transcript TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('duration_ms')) db.exec('ALTER TABLE sessions ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0');

  const SUMMARY = `s.id, s.title, s.kind, s.started_at AS startedAt, s.updated_at AS updatedAt,
    s.duration_ms AS durationMs, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turnCount`;
  const q = {
    insertSession: db.prepare('INSERT INTO sessions (id, title, started_at, updated_at) VALUES (?, ?, ?, ?)'),
    touchSession: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
    hasSession: db.prepare('SELECT 1 AS found FROM sessions WHERE id = ?'),
    insertTurn: db.prepare('INSERT INTO turns (session_id, question, answer, used_screen, at) VALUES (?, ?, ?, ?, ?)'),
    list: db.prepare(`SELECT ${SUMMARY} FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`),
    page: db.prepare(`SELECT ${SUMMARY} FROM sessions s ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`),
    count: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
    // Matches the title or any question or answer in the conversation.
    search: db.prepare(`
      SELECT ${SUMMARY} FROM sessions s
      WHERE s.title LIKE :p ESCAPE '\\'
         OR s.summary LIKE :p ESCAPE '\\'
         OR s.transcript LIKE :p ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id
                    AND (t.question LIKE :p ESCAPE '\\' OR t.answer LIKE :p ESCAPE '\\'))
      ORDER BY s.updated_at DESC LIMIT :limit`),
    session: db.prepare(`SELECT id, title, kind, summary, transcript, duration_ms AS durationMs,
      started_at AS startedAt, updated_at AS updatedAt FROM sessions WHERE id = ?`),
    saveMeeting: db.prepare(`
      INSERT INTO sessions (id, title, kind, summary, transcript, duration_ms, started_at, updated_at)
      VALUES (:id, :title, 'meeting', :summary, :transcript, :durationMs, :startedAt, :updatedAt)
      ON CONFLICT(id) DO UPDATE SET title = :title, summary = :summary, transcript = :transcript,
        duration_ms = :durationMs, updated_at = :updatedAt`),
    turns: db.prepare('SELECT question, answer, used_screen AS usedScreen, at FROM turns WHERE session_id = ? ORDER BY id'),
    prune: db.prepare('DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?)'),
    clear: db.prepare('DELETE FROM sessions'),
    remove: db.prepare('DELETE FROM sessions WHERE id = ?'), // its turns go with it (ON DELETE CASCADE)
  };

  return {
    /** Newest first; with a query, only conversations whose title or text contains it. */
    list(query = '') {
      const text = String(query || '').trim();
      if (!text) return q.list.all(LIST_LIMIT);
      const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return q.search.all({ p: pattern, limit: LIST_LIMIT });
    },

    /** One page of the newest-first list, for the History page's list as you scroll. */
    page(offset, limit) {
      return { items: q.page.all(limit, offset), total: q.count.get().n };
    },

    get(id) {
      const row = q.session.get(String(id));
      if (!row) return null;
      const { transcript, summary, ...session } = row;
      if (session.kind === 'meeting') {
        let entries = [];
        try {
          entries = JSON.parse(transcript);
        } catch {
          /* keep it empty */
        }
        return { ...session, summary, entries: Array.isArray(entries) ? entries : [] };
      }
      const turns = q.turns.all(session.id).map((t) => ({ ...t, usedScreen: Boolean(t.usedScreen) }));
      return { ...session, turns };
    },

    /** Save (or update) a listening session: { id, title, summary, entries, durationMs, startedAt }. */
    saveMeeting(meeting) {
      q.saveMeeting.run({
        id: String(meeting.id),
        title: String(meeting.title || 'Untitled session').slice(0, 200),
        summary: String(meeting.summary || ''),
        transcript: JSON.stringify(meeting.entries || []),
        durationMs: Math.round(meeting.durationMs || 0),
        startedAt: meeting.startedAt || Date.now(),
        updatedAt: Date.now(),
      });
      q.prune.run(MAX_SESSIONS);
    },

    /** Add one question and answer; starts a new session when id is null. Returns the id. */
    record(id, { question, answer, usedScreen }) {
      const now = Date.now();
      const turn = {
        question: String(question || ''),
        answer: String(answer || '').slice(0, MAX_ANSWER_CHARS),
        usedScreen: usedScreen ? 1 : 0,
      };
      let sessionId = id && q.hasSession.get(String(id)) ? String(id) : null;
      db.exec('BEGIN');
      try {
        if (sessionId) q.touchSession.run(now, sessionId);
        else {
          sessionId = crypto.randomUUID();
          q.insertSession.run(sessionId, makeTitle(turn), now, now);
        }
        q.insertTurn.run(sessionId, turn.question, turn.answer, turn.usedScreen, now);
        q.prune.run(MAX_SESSIONS);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return sessionId;
    },

    /** Delete one saved conversation or listening session. */
    remove(id) {
      q.remove.run(String(id));
    },

    clear() {
      q.clear.run();
      db.exec('VACUUM');
    },

    close() {
      db.close();
    },
  };
}

module.exports = { createHistory };
