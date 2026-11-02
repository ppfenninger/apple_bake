// Database schema and small query helpers for Cloudflare D1.
// The schema is created automatically the first time the site runs, so there is
// no separate migration step when you deploy.
import { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, truthy, splitList, displayCategory } from './logic.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (event_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (event_id, key))`,
  `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'judged',
     name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, ok_for TEXT NOT NULL DEFAULT '', web_voting INTEGER NOT NULL DEFAULT 0,
     places INTEGER NOT NULL DEFAULT 1, counts INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS judges (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, name TEXT NOT NULL, kerberos TEXT NOT NULL DEFAULT '',
     floor TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', restrictions TEXT NOT NULL DEFAULT '', restriction_details TEXT NOT NULL DEFAULT '',
     preferred TEXT NOT NULL DEFAULT '[]', assigned TEXT NOT NULL DEFAULT '[]', locked INTEGER NOT NULL DEFAULT 0,
     skip_tiebreak INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, number INTEGER NOT NULL, dish TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL DEFAULT '', kerberos TEXT NOT NULL DEFAULT '', floor TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL, UNIQUE (event_id, number))`,
  `CREATE TABLE IF NOT EXISTS judging (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, category_id INTEGER NOT NULL, judge_id INTEGER NOT NULL,
     role TEXT NOT NULL DEFAULT 'judge', entries TEXT NOT NULL DEFAULT '[]', sent_at TEXT, pick INTEGER, picked_at TEXT,
     closed INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '', recheck INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS votes (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, category_id INTEGER NOT NULL, entry INTEGER NOT NULL,
     votes INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'web', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS overrides (event_id INTEGER NOT NULL, category_id INTEGER NOT NULL, place INTEGER NOT NULL DEFAULT 1,
     entry INTEGER NOT NULL, PRIMARY KEY (event_id, category_id, place))`,
  `CREATE TABLE IF NOT EXISTS sms_log (id INTEGER PRIMARY KEY, event_id INTEGER, at TEXT NOT NULL, phone TEXT, name TEXT, body TEXT,
     status TEXT, sid TEXT)`,
  `CREATE INDEX IF NOT EXISTS judges_event ON judges (event_id)`,
  `CREATE INDEX IF NOT EXISTS entries_event ON entries (event_id)`,
  `CREATE INDEX IF NOT EXISTS judging_event ON judging (event_id)`,
  `CREATE INDEX IF NOT EXISTS votes_event ON votes (event_id)`,
  `CREATE INDEX IF NOT EXISTS categories_event ON categories (event_id)`,
];

let schemaReady = false;

export function now() {
  return new Date().toISOString();
}

export function randomToken(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}

export function randomPin() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  // Columns added after the first release: add them to older databases.
  const cols = (await db.prepare('PRAGMA table_info(judging)').all()).results.map(c => c.name);
  if (!cols.includes('recheck')) await db.prepare('ALTER TABLE judging ADD COLUMN recheck INTEGER NOT NULL DEFAULT 0').run();
  const ev = await db.prepare('SELECT id FROM events LIMIT 1').first();
  if (!ev) await createEvent(db, { name: 'Apple Bake ' + new Date().getFullYear(), copyFrom: null });
  schemaReady = true;
}

/** Creates an event. Copies settings and categories from copyFrom (an event id), or uses the defaults. */
export async function createEvent(db, { name, copyFrom, ingredient }) {
  const res = await db.prepare('INSERT INTO events (name, created_at) VALUES (?, ?)').bind(name, now()).run();
  const id = res.meta.last_row_id;
  const stmts = [];
  let settings = { ...DEFAULT_SETTINGS };
  if (copyFrom) {
    const rows = await db.prepare('SELECT key, value FROM settings WHERE event_id = ?').bind(copyFrom).all();
    rows.results.forEach(r => { settings[r.key] = r.value; });
    // A new event starts closed for voting/results and in test mode.
    Object.assign(settings, { checkin_open: 'true', signup_open: 'true', voting_open: 'false', results_public: 'false', test_mode: 'true' });
  }
  settings.checkin_pin = randomPin();
  if (ingredient) settings.ingredient = ingredient;
  Object.keys(settings).forEach(k => stmts.push(db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)').bind(id, k, String(settings[k]))));
  if (copyFrom) {
    stmts.push(db.prepare(`INSERT INTO categories (event_id, kind, name, active, ok_for, web_voting, places, counts, sort, notes)
      SELECT ?, kind, name, active, ok_for, web_voting, places, counts, sort, notes FROM categories WHERE event_id = ?`).bind(id, copyFrom));
  } else {
    DEFAULT_CATEGORIES.forEach(([kind, cname, ok, web = 0, places = 1, notes = ''], i) => {
      stmts.push(db.prepare(`INSERT INTO categories (event_id, kind, name, active, ok_for, web_voting, places, counts, sort, notes)
        VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`).bind(id, kind, cname, ok, web, places, i * 10, notes));
    });
  }
  stmts.push(db.prepare("INSERT INTO meta (key, value) VALUES ('active_event', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(id)));
  await db.batch(stmts);
  return id;
}

export async function activeEventId(db) {
  const r = await db.prepare("SELECT value FROM meta WHERE key = 'active_event'").first();
  if (r) return Number(r.value);
  const ev = await db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').first();
  return ev ? ev.id : null;
}

export async function getEvent(db, id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function getSettings(db, eventId) {
  const out = { ...DEFAULT_SETTINGS };
  const rows = await db.prepare('SELECT key, value FROM settings WHERE event_id = ?').bind(eventId).all();
  rows.results.forEach(r => { out[r.key] = r.value; });
  return out;
}

export async function setSettings(db, eventId, values) {
  const stmts = Object.keys(values).filter(k => k in DEFAULT_SETTINGS).map(k =>
    db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?) ON CONFLICT(event_id, key) DO UPDATE SET value = excluded.value')
      .bind(eventId, k, String(values[k] ?? '')));
  if (stmts.length) await db.batch(stmts);
}

/** Reads a whole event into plain objects, with JSON columns parsed and category names filled in. */
export async function loadEvent(db, eventId) {
  const [event, settings, cats, judges, entries, judging, votes, overrides] = await Promise.all([
    getEvent(db, eventId),
    getSettings(db, eventId),
    db.prepare('SELECT * FROM categories WHERE event_id = ? ORDER BY sort, id').bind(eventId).all(),
    db.prepare('SELECT * FROM judges WHERE event_id = ? ORDER BY id').bind(eventId).all(),
    db.prepare('SELECT * FROM entries WHERE event_id = ? ORDER BY number').bind(eventId).all(),
    db.prepare('SELECT * FROM judging WHERE event_id = ? ORDER BY id').bind(eventId).all(),
    db.prepare('SELECT * FROM votes WHERE event_id = ? ORDER BY id').bind(eventId).all(),
    db.prepare('SELECT * FROM overrides WHERE event_id = ?').bind(eventId).all(),
  ]);
  const parse = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const categories = cats.results.map(c => ({
    ...c, active: !!c.active, web_voting: !!c.web_voting, counts: !!c.counts,
    display: displayCategory(c.name, settings.ingredient), ok: splitList(c.ok_for).map(s => s.toLowerCase()),
  }));
  return {
    event, settings, categories,
    judges: judges.results.map(j => ({
      ...j, locked: !!j.locked, skip_tiebreak: !!j.skip_tiebreak,
      preferred: parse(j.preferred), assigned: parse(j.assigned), tags: splitList(j.restrictions).map(s => s.toLowerCase()),
    })),
    entries: entries.results.map(e => ({ ...e, categories: parse(e.categories) })),
    // A pick waiting to be re-confirmed after a late dish counts as no pick; "previous" keeps what they chose.
    judging: judging.results.map(r => ({ ...r, entries: parse(r.entries), closed: !!r.closed, recheck: !!r.recheck,
      previous: r.pick, pick: r.recheck ? null : r.pick })),
    votes: votes.results,
    overrides: overrides.results,
  };
}

export function settingBool(settings, key) {
  return truthy(settings[key]);
}

export function settingNum(settings, key, fallback) {
  const n = Number(settings[key]);
  return Number.isFinite(n) && settings[key] !== '' ? n : fallback;
}
