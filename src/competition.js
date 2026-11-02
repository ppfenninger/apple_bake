// Event workflows: assigning judges, texting judging links, recording picks,
// tiebreaks, and working out results. Database reads/writes live here; the
// pure decision rules are in logic.js.
import {
  assignJudges, decideCategory, tallyVotes, computeStandings, chooseTiebreaker,
  splitList, normalizePhone, entryList, truthy,
} from './logic.js';
import { loadEvent, now, settingBool, settingNum } from './db.js';

// ---------------------------------------------------------------------------
// Texting
// ---------------------------------------------------------------------------

/** Sends (or, in test mode, only logs) a text. Returns {ok, status}. */
export async function sendSms(env, eventId, settings, to, body, name) {
  const db = env.DB;
  let status, sid = '';
  if (!to) status = 'skipped: no phone';
  else if (settingBool(settings, 'test_mode')) status = 'TEST MODE (not sent)';
  else {
    const from = normalizePhone(settings.twilio_from);
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) status = 'not sent: Twilio is not set up';
    else {
      try {
        const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
        });
        const json = await resp.json().catch(() => ({}));
        status = resp.ok ? 'sent' : 'error: ' + (json.message || resp.status);
        sid = json.sid || '';
      } catch (e) {
        status = 'error: ' + e.message;
      }
    }
  }
  await db.prepare('INSERT INTO sms_log (event_id, at, phone, name, body, status, sid) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(eventId, now(), to || '', name || '', body, status, sid).run();
  return { ok: status === 'sent' || status.startsWith('TEST'), status };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function judgeLink(origin, judge) {
  return origin.replace(/\/$/, '') + '/j/' + judge.token;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function runAssignment(env, eventId) {
  const data = await loadEvent(env.DB, eventId);
  const s = data.settings;
  const cats = data.categories.filter(c => c.kind === 'judged' && c.active).map(c => ({ id: c.id, name: c.display, ok: c.ok }));
  const judges = data.judges.map(j => ({ id: j.id, name: j.name, floor: j.floor, tags: j.tags, prefs: j.preferred, locked: j.locked, assigned: j.assigned }));
  if (!judges.length) return { error: 'There are no judges yet.' };
  const res = assignJudges(judges, cats, {
    perCat: settingNum(s, 'judges_per_category', 2),
    maxPerJudge: settingNum(s, 'max_categories_per_judge', 2),
    diffFloors: settingBool(s, 'cojudges_different_floors'),
  });
  const stmts = judges.filter(j => !j.locked).map(j =>
    env.DB.prepare('UPDATE judges SET assigned = ? WHERE id = ?').bind(JSON.stringify(res.assigned[judges.indexOf(j)]), j.id));
  if (stmts.length) await env.DB.batch(stmts);
  return {
    judges: judges.length, categories: cats.length,
    shortages: res.shortages, overloaded: res.overloaded, unassigned: res.unassigned,
    noFloor: judges.filter(j => !j.floor).map(j => j.name),
  };
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

function entriesByCategory(data) {
  const by = {};
  data.categories.forEach(c => { by[c.id] = []; });
  data.entries.forEach(e => e.categories.forEach(cid => { if (by[cid]) by[cid].push(e); }));
  Object.values(by).forEach(list => list.sort((a, b) => a.number - b.number));
  return by;
}

/**
 * Starts judging: texts every assigned judge a link to their judging page.
 * Check-in can stay open; dishes added later are synced to the judges (syncJudging).
 * restart: clear existing judging rows first. closeCheckin: also close check-in.
 */
export async function sendJudging(env, eventId, origin, { restart = false, closeCheckin = false } = {}) {
  const db = env.DB;
  if (restart) await db.prepare('DELETE FROM judging WHERE event_id = ?').bind(eventId).run();
  if (closeCheckin) await db.prepare("INSERT INTO settings (event_id, key, value) VALUES (?, 'checkin_open', 'false') ON CONFLICT(event_id, key) DO UPDATE SET value = 'false'").bind(eventId).run();
  const data = await loadEvent(db, eventId);
  const s = data.settings;
  const by = entriesByCategory(data);
  const judged = data.categories.filter(c => c.kind === 'judged' && c.active);
  const judgedIds = judged.map(c => c.id);
  const avoidOwn = settingBool(s, 'avoid_own_floor');
  const existing = new Set(data.judging.filter(r => r.role === 'judge').map(r => r.judge_id + ':' + r.category_id));

  const inserts = [];
  const toText = [];
  const covered = new Set();
  data.judges.forEach(j => {
    const mine = [];
    j.assigned.filter(cid => judgedIds.includes(cid)).forEach(cid => {
      if (by[cid].length < 2) return; // nothing to judge with 0 or 1 dishes
      covered.add(cid);
      if (existing.has(j.id + ':' + cid)) return;
      const flags = [];
      if (!j.phone) flags.push('no phone');
      if (avoidOwn && j.floor && by[cid].some(e => e.floor === j.floor)) flags.push("judge's floor has dishes here");
      mine.push(cid);
      inserts.push(db.prepare('INSERT INTO judging (event_id, category_id, judge_id, role, entries, sent_at, flags) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(eventId, cid, j.id, 'judge', JSON.stringify(by[cid].map(e => e.number)), now(), flags.join('; ')));
    });
    if (mine.length) toText.push({ judge: j, cats: mine });
  });
  if (inserts.length) await db.batch(inserts);

  let sent = 0;
  for (const t of toText) {
    const names = t.cats.map(cid => judged.find(c => c.id === cid).display);
    const body = `Hi ${firstName(t.judge.name)}! ${data.event.name} judging is open. You're judging ${names.join(' and ')}. ` +
      `Taste the numbered dishes, then tap to pick your favorite: ${judgeLink(origin, t.judge)}`;
    if ((await sendSms(env, eventId, s, t.judge.phone, body, t.judge.name)).ok) sent++;
  }
  const gaps = judged.filter(c => by[c.id].length >= 2 && !covered.has(c.id)).map(c => c.display);
  const autoWon = judged.filter(c => by[c.id].length === 1).map(c => c.display);
  return {
    texted: sent, judges: toText.length, testMode: settingBool(s, 'test_mode'), gaps, autoWon,
    flagged: inserts.length ? (await db.prepare("SELECT COUNT(*) AS n FROM judging WHERE event_id = ? AND flags != ''").bind(eventId).first()).n : 0,
  };
}

/** Re-texts one judge their link (after a fix to their phone or a late assignment). Adds rows for new assignments. */
export async function resendJudge(env, eventId, judgeId, origin) {
  const db = env.DB;
  const data = await loadEvent(db, eventId);
  const judge = data.judges.find(j => j.id === judgeId);
  if (!judge) return { error: 'No such judge.' };
  const by = entriesByCategory(data);
  const judged = data.categories.filter(c => c.kind === 'judged' && c.active);
  const have = new Set(data.judging.filter(r => r.judge_id === judgeId && r.role === 'judge').map(r => r.category_id));
  const adds = judge.assigned.filter(cid => judged.some(c => c.id === cid) && !have.has(cid) && by[cid].length >= 2)
    .map(cid => db.prepare('INSERT INTO judging (event_id, category_id, judge_id, role, entries, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(eventId, cid, judgeId, 'judge', JSON.stringify(by[cid].map(e => e.number)), now()));
  if (adds.length) await db.batch(adds);
  const body = `Hi ${firstName(judge.name)}! Here's your ${data.event.name} judging link: ${judgeLink(origin, judge)}`;
  const r = await sendSms(env, eventId, data.settings, judge.phone, body, judge.name);
  return { status: r.status, added: adds.length };
}

/** What a judge sees on their link. */
export async function judgeView(env, token) {
  const judge = await env.DB.prepare('SELECT * FROM judges WHERE token = ?').bind(token).first();
  if (!judge) return null;
  const data = await loadEvent(env.DB, judge.event_id);
  const rows = data.judging.filter(r => r.judge_id === judge.id && r.sent_at);
  return {
    eventName: data.event.name,
    judgeName: judge.name,
    rows: rows.map(r => {
      const cat = data.categories.find(c => c.id === r.category_id) || { display: '?' };
      const siblings = data.judging.filter(x => x.category_id === r.category_id);
      return {
        id: r.id, category: cat.display, role: r.role, entries: r.entries, pick: r.pick, previous: r.previous, recheck: r.recheck,
        locked: pickLocked(r, siblings), closed: r.closed,
        note: r.recheck ? 'A new dish was added. Taste it, then confirm or change your pick.'
          : r.role === 'tiebreaker' ? 'Tiebreaker: the other judges split between these.'
            : r.role === 'final' ? 'You and your co-judges were tied. Agree on one, and one of you submits it.'
              : '',
      };
    }),
  };
}

/** A judge's pick can change until every judge in the category has answered (then a tie may already be in motion). */
function pickLocked(row, catRows) {
  if (row.closed) return true;
  if (row.role !== 'judge') return row.pick !== null;
  return catRows.filter(r => r.role === 'judge').every(r => r.pick !== null);
}

/** Saves a judge's picks: {rowId: entryNumber}. Starts tiebreaks as needed. */
export async function submitPicks(env, token, picks, origin) {
  const db = env.DB;
  const judge = await db.prepare('SELECT * FROM judges WHERE token = ?').bind(token).first();
  if (!judge) return { error: 'This judging link is not valid.' };
  const data = await loadEvent(db, judge.event_id);
  const errors = [];
  const touched = new Set();
  const stmts = [];
  Object.keys(picks || {}).forEach(id => {
    const row = data.judging.find(r => r.id === Number(id) && r.judge_id === judge.id);
    const n = Number(picks[id]);
    if (!row) return;
    const cat = data.categories.find(c => c.id === row.category_id);
    if (pickLocked(row, data.judging.filter(r => r.category_id === row.category_id))) {
      if (row.pick !== n) errors.push((cat ? cat.display : 'That category') + ' is already decided, so your pick can no longer change.');
      return;
    }
    if (!row.entries.includes(n)) { errors.push('#' + n + ' is not in ' + (cat ? cat.display : 'that category') + '.'); return; }
    stmts.push(db.prepare('UPDATE judging SET pick = ?, picked_at = ?, recheck = 0 WHERE id = ?').bind(n, now(), row.id));
    row.pick = n;
    touched.add(row.category_id);
    if (row.role === 'final') {
      data.judging.filter(r => r.category_id === row.category_id && r.role === 'final' && r.id !== row.id && r.pick === null)
        .forEach(r => stmts.push(db.prepare("UPDATE judging SET closed = 1, flags = ? WHERE id = ?").bind('answered by ' + judge.name, r.id)));
    }
  });
  if (stmts.length) await db.batch(stmts);
  for (const cid of touched) await afterPick(env, judge.event_id, cid, origin);
  return { saved: stmts.length > 0, errors };
}

/**
 * Keeps judging in step with the dishes once judging has started. Run after any dish is
 * added, edited or removed, and after judge assignments change:
 * - a new dish in a category is added to its judges' lists, and they get a text; judges who
 *   had already picked must taste it and confirm or change their pick
 * - a dish removed from a category comes off the lists (a pick for it is cleared)
 * - a category that reaches 2 dishes, or a judge newly assigned, gets judging rows and a first text
 */
export async function syncJudging(env, eventId, origin) {
  const db = env.DB;
  const started = await db.prepare('SELECT COUNT(*) AS n FROM judging WHERE event_id = ?').bind(eventId).first();
  if (!started.n) return { started: false };
  const data = await loadEvent(db, eventId);
  const by = entriesByCategory(data);
  const stmts = [];
  const notes = {}; // judgeId -> [lines]
  const note = (jid, line) => (notes[jid] = notes[jid] || []).push(line);
  const changedCats = [];
  data.categories.filter(c => c.kind === 'judged' && c.active).forEach(cat => {
    const nums = by[cat.id].map(e => e.number);
    const rows = data.judging.filter(r => r.category_id === cat.id && r.role === 'judge');
    let changed = false;
    rows.forEach(r => {
      const added = nums.filter(n => !r.entries.includes(n));
      const removed = r.entries.filter(n => !nums.includes(n));
      if (!added.length && !removed.length) return;
      changed = true;
      let pick = r.previous, recheck = r.recheck ? 1 : 0;
      if (pick !== null && removed.includes(pick)) { pick = null; recheck = 0; }
      if (added.length && pick !== null) recheck = 1;
      stmts.push(db.prepare('UPDATE judging SET entries = ?, pick = ?, recheck = ? WHERE id = ?').bind(JSON.stringify(nums), pick, recheck, r.id));
      if (added.length && nums.length >= 2) {
        note(r.judge_id, 'New dish ' + entryList(added) + ' was added to ' + cat.display + '.' +
          (pick !== null ? ' Please taste it and confirm or change your pick.' : ''));
      }
    });
    // Judges assigned to this category who have no row yet (late category or late assignment).
    if (nums.length >= 2) {
      data.judges.filter(j => j.assigned.includes(cat.id) && !rows.some(r => r.judge_id === j.id)).forEach(j => {
        stmts.push(db.prepare('INSERT INTO judging (event_id, category_id, judge_id, role, entries, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(eventId, cat.id, j.id, 'judge', JSON.stringify(nums), now()));
        note(j.id, "You're now judging " + cat.display + ' (' + entryList(nums) + ').');
      });
    }
    if (changed) {
      changedCats.push(cat.id);
      // A tie that was being broken is moot now that the dishes changed.
      data.judging.filter(r => r.category_id === cat.id && (r.role === 'tiebreaker' || r.role === 'final'))
        .forEach(r => stmts.push(db.prepare('DELETE FROM judging WHERE id = ?').bind(r.id)));
    }
  });
  if (stmts.length) await db.batch(stmts);
  let texted = 0;
  for (const jid of Object.keys(notes)) {
    const j = data.judges.find(x => x.id === Number(jid));
    const body = `${data.event.name}: ${notes[jid].join(' ')} Your link: ${judgeLink(origin, j)}`;
    if ((await sendSms(env, eventId, data.settings, j.phone, body, j.name)).ok) texted++;
  }
  for (const cid of changedCats) await afterPick(env, eventId, cid, origin);
  return { started: true, texted, changedCategories: changedCats.length };
}

/** After a pick: if the category's judges are tied, bring in a tiebreaker (or ask the judges to agree). */
export async function afterPick(env, eventId, categoryId, origin) {
  const db = env.DB;
  const data = await loadEvent(db, eventId);
  const rows = data.judging.filter(r => r.category_id === categoryId);
  const named = rows.map(r => ({ ...r, judge: (data.judges.find(j => j.id === r.judge_id) || {}).name || '?' }));
  const d = decideCategory(named);
  if (d.status !== 'tie') return d;
  const s = data.settings;
  const cat = data.categories.find(c => c.id === categoryId);
  const finalistFloors = data.entries.filter(e => d.finalists.includes(e.number)).map(e => e.floor);
  const method = String(s.tiebreak_method || 'third judge').toLowerCase();

  if (method.includes('ask')) {
    const judgeRows = rows.filter(r => r.role === 'judge');
    await db.batch(judgeRows.map(r => db.prepare('INSERT INTO judging (event_id, category_id, judge_id, role, entries, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(eventId, categoryId, r.judge_id, 'final', JSON.stringify(d.finalists), now())));
    for (const r of judgeRows) {
      const j = data.judges.find(x => x.id === r.judge_id);
      const others = judgeRows.filter(x => x.judge_id !== r.judge_id).map(x => firstName((data.judges.find(y => y.id === x.judge_id) || {}).name));
      const body = `${cat.display} is a tie between ${entryList(d.finalists)}. Talk it over with ${others.join(' & ')}, ` +
        `then ONE of you submits the final pick: ${judgeLink(origin, j)}`;
      await sendSms(env, eventId, s, j.phone, body, j.name);
    }
    return { status: 'tiebreak-sent' };
  }

  const load = id => data.judging.filter(r => r.judge_id === id && r.pick === null && !r.closed).length;
  const pool = data.judges.map(j => ({ id: j.id, name: j.name, floor: j.floor, phone: j.phone, tags: j.tags, skipTiebreak: j.skip_tiebreak }));
  const tb = chooseTiebreaker(pool, { ok: cat.ok }, rows.map(r => r.judge_id), finalistFloors, load, settingBool(s, 'avoid_own_floor'));
  if (!tb) {
    await db.prepare("UPDATE judging SET flags = 'tie: no tiebreaker available' WHERE category_id = ? AND role = 'judge'").bind(categoryId).run();
    const org = normalizePhone(s.organizer_phone);
    if (org) await sendSms(env, eventId, s, org, `${data.event.name}: ${cat.display} is tied (${entryList(d.finalists)}) and no tiebreaker is free. Pick a winner on the admin Results tab.`, 'Organizer');
    return { status: 'tie', finalists: d.finalists, noTiebreaker: true };
  }
  const judge = data.judges.find(j => j.id === tb.id);
  await db.prepare('INSERT INTO judging (event_id, category_id, judge_id, role, entries, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(eventId, categoryId, judge.id, 'tiebreaker', JSON.stringify(d.finalists), now()).run();
  const body = `Hi ${firstName(judge.name)}! We need a tiebreaker for ${cat.display} at ${data.event.name}: ` +
    `taste ${entryList(d.finalists)}, then tap to pick: ${judgeLink(origin, judge)}`;
  await sendSms(env, eventId, s, judge.phone, body, judge.name);
  return { status: 'tiebreak-sent', tiebreaker: judge.name };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Works out every category's winner and the floor standings for a loaded event. */
export function computeResults(data) {
  const s = data.settings;
  const floors = splitList(s.floors);
  const byNumber = {};
  data.entries.forEach(e => { byNumber[e.number] = e; });
  const overrides = {};
  data.overrides.forEach(o => { overrides[o.category_id + '|' + o.place] = o.entry; });
  const judgeName = id => (data.judges.find(j => j.id === id) || {}).name || '?';
  const results = [];
  const describe = (cat, place, number, how) => {
    const e = byNumber[number] || {};
    return {
      categoryId: cat.id, category: cat.display, type: cat.kind, place, entry: number || null, dish: e.dish || '', name: e.name || '',
      kerberos: e.kerberos || '', floor: e.floor || '', how, override: overrides[cat.id + '|' + place] || null,
      status: number ? 'decided' : (how === 'No entries' || how === 'No votes yet' ? 'none' : 'pending'),
    };
  };

  data.categories.filter(c => c.kind === 'judged' && c.active).forEach(cat => {
    const inCat = data.entries.filter(e => e.categories.includes(cat.id));
    const ov = overrides[cat.id + '|1'];
    if (ov) return results.push(describe(cat, 1, ov, 'Set by organizer'));
    if (!inCat.length) return results.push(describe(cat, 1, null, 'No entries'));
    if (inCat.length === 1) return results.push(describe(cat, 1, inCat[0].number, 'Only entry'));
    const rows = data.judging.filter(r => r.category_id === cat.id).map(r => ({ ...r, judge: judgeName(r.judge_id) }));
    const d = decideCategory(rows);
    if (d.status === 'decided') return results.push(describe(cat, 1, d.winner, d.method));
    let how = 'Judging links not sent yet';
    if (d.status === 'waiting') how = 'Waiting on ' + d.waitingOn.join(', ');
    if (d.status === 'tie') how = 'Tied: ' + entryList(d.finalists);
    if (d.status === 'tiebreak-sent') how = 'Tied ' + entryList(d.finalists) + ', waiting on ' + (d.waitingOn.join(', ') || 'tiebreak');
    results.push(describe(cat, 1, null, how));
  });

  data.categories.filter(c => c.kind === 'special' && c.active).forEach(cat => {
    const tally = tallyVotes(data.votes.filter(v => v.category_id === cat.id).map(v => ({ entry: v.entry, votes: v.votes })));
    for (let place = 1; place <= Math.max(1, cat.places || 1); place++) {
      const ov = overrides[cat.id + '|' + place];
      if (ov) { results.push(describe(cat, place, ov, 'Set by organizer')); continue; }
      const t = tally[place - 1];
      if (!t) { results.push(describe(cat, place, null, 'No votes yet')); continue; }
      const tied = tally.filter((x, i) => i !== place - 1 && x.votes === t.votes).map(x => x.entry);
      results.push(describe(cat, place, t.entry, t.votes + ' vote' + (t.votes === 1 ? '' : 's') + (tied.length ? ' (tied with ' + entryList(tied) + ')' : '')));
    }
  });

  const countSpecial = truthy(s.special_counts);
  const counted = {};
  data.categories.forEach(c => { counted[c.id] = c.counts; });
  const wins = results.filter(r => r.status === 'decided' && r.place === 1 && (r.type === 'judged' || (countSpecial && counted[r.categoryId])))
    .map(r => ({ floor: r.floor, entry: r.entry, category: r.category }));
  const standings = computeStandings(wins, floors, settingNum(s, 'top_floors', 3));
  const winnerKerberos = [];
  results.filter(r => r.status === 'decided' && r.kerberos).forEach(r => splitList(r.kerberos).forEach(k => {
    if (!winnerKerberos.includes(k)) winnerKerberos.push(k);
  }));
  return { results, standings, winnerKerberos, complete: results.every(r => r.status !== 'pending') };
}
