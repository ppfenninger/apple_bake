// End-to-end test against a running site (npm run dev in another terminal).
//   ADMIN_PASSWORD=... node test/e2e.mjs [event-data.json]
// Without a data file it makes up 28 judges and 100 dishes. It creates its own
// "E2E test" event, so run it against a local database, not the live site.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRestrictions, normalizeFloor, toCsv, dietOk } from '../src/logic.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const PASSWORD = process.env.ADMIN_PASSWORD || 'test-password';
const floors = ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5'];

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split("\n").slice(0, 14).join('\n       ')); process.exitCode = 1; }
}

function client() {
  let cookie = '';
  return async function call(path, { method, body } = {}) {
    const res = await fetch(BASE + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data };
  };
}

// --- data -----------------------------------------------------------------------
let data;
if (process.argv[2]) data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
else {
  const cats = ['Cakes/breads', 'Pies/tarts', 'Cookies', 'Frozen', 'Other sweets', 'Stovetop', 'Savory', 'Drinks', 'Vegan', 'Kosher'];
  data = {
    judges: Array.from({ length: 28 }, (_, i) => ({ name: 'Judge ' + i, email: 'judge' + i + '@mit.edu', floor: floors[i % floors.length].toLowerCase(),
      phone: '617555' + String(1000 + i), diet: ['none', 'vegan', 'peanut allergy', 'no', 'celiac'][i % 5], prefs: cats[Math.floor(i / 3) % cats.length] })),
    entries: Array.from({ length: 100 }, (_, i) => ({ name: 'Baker ' + (i % 40), number: i + 1, floor: ['C2', 'C2', 'B2', 'C5', 'B1'][i % 5], category: cats[i % cats.length] })),
  };
}

const admin = client(), judgeClient = client(), table = client(), anon = client();
let awayIds = [];
let A; // admin data
const refresh = async () => { A = (await admin('/api/admin/data')).data; return A; };

console.log('E2E against ' + BASE);

await step('admin pages need a login', async () => {
  assert.equal((await anon('/api/admin/data')).status, 401);
  assert.equal((await anon('/api/checkin')).status, 401);
  assert.equal((await admin('/api/admin/login', { body: { password: 'nope' } })).status, 401);
  assert.equal((await admin('/api/admin/login', { body: { password: PASSWORD } })).status, 200);
  await refresh();
  assert.ok(A.events.length >= 1);
});

const firstEventId = A.activeEventId;
await step('new event starts from defaults and becomes live', async () => {
  const r = await admin('/api/admin/events', { body: { name: 'E2E test ' + Date.now(), ingredient: 'carrot', copyFrom: 'defaults' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await refresh();
  assert.equal(A.activeEventId, r.data.id);
  assert.ok(A.categories.some(c => c.display === 'Most Creative Carrot'));
  assert.equal(A.categories.filter(c => c.kind === 'special').length, 5);
  const pre = (await admin('/api/admin/send-judging', { body: { dryRun: true } })).data;
  assert.equal(pre.judges, 0);
  assert.match(pre.why.join(' '), /no judges/);
  assert.equal(pre.twilio.testMode, true);
});
const eventId = A.activeEventId;

await step('judge signup page saves and updates', async () => {
  let r = await anon('/api/signup', { body: { name: 'Sign Up', email: 'SIGNUP@mit.edu', phone: '617 555 0000', floor: 'B4', restrictions: ['vegan'], prefs: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await anon('/api/signup', { body: { name: 'Sign Up', email: 'signup', phone: '6175550001', floor: 'B4', restrictions: [], details: 'sesame', prefs: [] } });
  assert.equal(r.data.updated, true);
  assert.equal((await anon('/api/signup', { body: { name: 'x', email: 'y', phone: '12', floor: 'B4' } })).status, 400);
  await refresh();
  const j = A.judges.find(x => x.kerberos === 'signup');
  assert.equal(j.phone, '+16175550001');
  assert.deepEqual(j.tags, ['other']);
  await admin('/api/admin/rows/judges/' + j.id, { method: 'DELETE' });
});

await step('CSV import cleans floors, phones and diets', async () => {
  const csv = toCsv([['Name:', 'MIT email address:', 'Floor:', 'Do you have any allergies or dietary restrictions?', 'Cell#', 'Category']]
    .concat(data.judges.map(j => [j.name, j.email, j.floor, j.diet, j.phone, j.prefs])));
  const r = await admin('/api/admin/import-judges', { body: { csv } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, data.judges.length);
  console.log('       import flagged: ' + (r.data.problems.join(' | ') || 'nothing'));
  await refresh();
  // Fix any unreadable floor by hand, like an organizer would.
  for (const j of A.judges.filter(x => !x.floor)) await admin('/api/admin/rows/judges/' + j.id, { method: 'PATCH', body: { values: { floor: 'B1' } } });
  await refresh();
  assert.ok(A.judges.every(j => floors.includes(j.floor)));
});

await step('assignment: 2+ judges per category, different floors, diet-safe', async () => {
  const r = await admin('/api/admin/assign', { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await refresh();
  const cats = A.categories.filter(c => c.kind === 'judged' && c.active);
  const by = {};
  A.judges.forEach(j => {
    assert.ok(j.assigned.length <= 3, j.name + ' has ' + j.assigned.length);
    j.assigned.forEach(cid => {
      (by[cid] = by[cid] || []).push(j);
      const c = cats.find(x => x.id === cid);
      const tags = j.tags.filter(t => t !== 'other');
      assert.ok(!tags.length || c.ok.includes('all') || tags.every(t => c.ok.includes(t)), j.name + ' diet vs ' + c.display);
    });
  });
  Object.values(by).forEach(list => assert.equal(new Set(list.map(j => j.floor)).size, list.length));
  const covered = cats.filter(c => (by[c.id] || []).length >= 2).length;
  const happy = A.judges.filter(j => j.assigned.some(c => j.preferred.includes(c))).length;
  console.log('       ' + covered + '/' + cats.length + ' categories have 2+ judges; ' + happy + '/' + A.judges.length + ' judges got a category they asked for');
  if (r.data.shortages.length) console.log('       short: ' + r.data.shortages.map(s => s.category).join(', '));
});

await step('check-in needs the PIN, then records dishes; duplicate numbers are refused', async () => {
  assert.equal((await table('/api/checkin/login', { body: { pin: '000000' } })).status, 401);
  assert.equal((await table('/api/checkin/login', { body: { pin: A.settings.checkin_pin } })).status, 200);
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { entry_numbers: 'manual' } } });
  const info = (await table('/api/checkin')).data;
  const catId = name => {
    const k = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const c = info.categories.find(x => k(x.name) === k(name));
    assert.ok(c, 'no category ' + name);
    return c.id;
  };
  const errors = [];
  for (const e of data.entries) {
    const floor = normalizeFloor(e.floor, floors, ['Alumni']) || 'Alumni';
    const r = await table('/api/checkin', { body: { name: e.name, kerberos: e.name.toLowerCase().replace(/\W/g, ''), floor,
      dishes: [{ dish: e.category + ' by ' + e.name, number: e.number, categories: [catId(e.category)] }] } });
    if (r.status !== 200) errors.push('#' + e.number + ': ' + r.data.error);
  }
  const unique = new Set(data.entries.map(e => e.number)).size;
  assert.equal(errors.length, data.entries.length - unique, errors.join('; '));
  if (errors.length) console.log('       refused: ' + errors.join('; '));
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { entry_numbers: 'auto' } } });
  const r = await table('/api/checkin', { body: { name: 'Late Baker', kerberos: 'late', floor: 'C4',
    dishes: [{ dish: 'Carrot halwa', categories: [catId('Stovetop')] }, { dish: 'Carrot lemonade', categories: [catId('Drinks')] }] } });
  const max = Math.max(...data.entries.map(e => e.number));
  assert.deepEqual(r.data.map(x => x.number), [max + 1, max + 2]);
  const bad = await table('/api/checkin', { body: { name: 'No Dish', kerberos: 'nd', floor: 'C2', dishes: [{ dish: '', categories: [catId('Cookies')] }] } });
  assert.match(bad.data.error, /needs a name/);
  const noKerb = await table('/api/checkin', { body: { name: 'No Kerb', floor: 'C2', dishes: [{ dish: 'Pie', categories: [catId('Cookies')] }] } });
  assert.match(noKerb.data.error, /kerberos/);
  const twoKerb = await table('/api/checkin', { body: { name: 'Sam and Alex', kerberos: 'sam, alex', floor: 'C2', dishes: [{ dish: 'Pie', categories: [catId('Cookies')] }] } });
  assert.match(twoKerb.data.error, /Only one kerberos/);
});

await step('starting judging texts each judge a link (test mode) and leaves check-in open', async () => {
  // Nobody has checked in yet, so nobody would be texted.
  const none = (await admin('/api/admin/send-judging', { body: { dryRun: true } })).data;
  assert.equal(none.judges, 0);
  assert.match(none.why.join(' '), /checked in/);
  // Judges check in on the public page by looking up their name. Three assigned judges stay away for now.
  await refresh();
  const dishCount = cid => A.entries.filter(e => e.categories.includes(cid)).length;
  awayIds = A.judges.filter(j => j.assigned.some(cid => dishCount(cid) >= 2)).slice(0, 3).map(j => j.id);
  const first = A.judges.find(j => !awayIds.includes(j.id));
  const found = (await anon('/api/judge-checkin?q=' + encodeURIComponent(first.name.toLowerCase()))).data;
  assert.ok(found.judges.some(j => j.id === first.id), 'name lookup finds the judge');
  assert.equal((await anon('/api/judge-checkin?q=a')).data.judges.length, 0, 'needs 2+ letters');
  for (const j of A.judges.filter(j => !awayIds.includes(j.id))) {
    const c = await anon('/api/judge-checkin', { body: { id: j.id } });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    assert.equal(c.data.started, false);
  }
  const backupsBefore = (await refresh()).judges.filter(j => !j.assigned.length).length;
  const r = await admin('/api/admin/send-judging', { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.testMode, true);
  const away = A.judges.filter(j => awayIds.includes(j.id)).map(j => j.name);
  assert.ok(!r.data.results.some(x => away.includes(x.name)), 'judges who are not checked in get no text');
  assert.equal(away.length, 3);
  assert.deepEqual(r.data.notHere.sort(), away.sort());
  // A category can only be left without a checked-in judge if no checked-in judge could take it.
  await refresh();
  const maxPer = Number(A.settings.max_categories_per_judge || 2);
  for (const g of r.data.gaps) {
    const cat = A.categories.find(c => c.display === g);
    const free = A.judges.filter(j => j.checked_in && j.assigned.length < maxPer && dietOk(j, cat));
    assert.deepEqual(free.map(j => j.name), [], g + ' has no judge although a checked-in judge had room');
  }
  if (r.data.gaps.length) console.log('       no free judge for: ' + r.data.gaps.join(', ') + ' (assigning one by hand)');
  // Like an organizer would: give each gap to a checked-in judge by hand. They get a text right away.
  for (const g of r.data.gaps) {
    const cat = A.categories.find(c => c.display === g);
    const j = A.judges.find(x => x.checked_in && dietOk(x, cat) && !x.assigned.includes(cat.id));
    const logBefore = A.log.length;
    await admin('/api/admin/rows/judges/' + j.id, { method: 'PATCH', body: { values: { assigned: j.assigned.concat(cat.id) } } });
    await refresh();
    assert.ok(A.judging.some(x => x.judge_id === j.id && x.category_id === cat.id), 'hand assignment creates a judging row');
    assert.equal(A.log.length - logBefore, 1, 'and texts that judge');
  }
  console.log('       ' + backupsBefore + ' backups; placed: ' + (r.data.backups.map(b => b.name + ' to ' + b.category + ' (' + b.reason + ')').join('; ') || 'none'));
  await refresh();
  assert.equal(A.settings.checkin_open, 'true');
  assert.ok(A.log.length >= r.data.judges && r.data.judges > 5);
  assert.ok(A.log.every(l => /TEST MODE/.test(l.status)));
  const sample = A.log[A.log.length - 1];
  assert.match(sample.body, /\/j\/[a-z0-9]+/);
  console.log('       sample text: ' + sample.body);
  console.log('       ' + r.data.texted + ' judges texted; won with one dish: ' + (r.data.autoWon.join(', ') || 'none') + '; no judge: ' + (r.data.gaps.join(', ') || 'none'));
  const again = await admin('/api/admin/send-judging', { body: {} });
  assert.equal(again.data.judges, 0, 'a second run should not re-text anyone');
});

await step('a judge who checks in after judging started is texted right away', async () => {
  const late = A.judges.find(j => j.id === awayIds[0]);
  const logBefore = A.log.length;
  const c = await anon('/api/judge-checkin', { body: { id: late.id } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.started, true);
  assert.match(c.data.message, /texted you your judging link/);
  await refresh();
  const texts = A.log.slice(0, A.log.length - logBefore);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].name, late.name);
  assert.ok(A.judging.some(r => r.judge_id === late.id), 'their judging rows exist now');
  console.log('       late check-in text: ' + texts[0].body);
});

await step('preview explains an empty send; judges only logged in test mode get real texts later', async () => {
  const pre = (await admin('/api/admin/send-judging', { body: { dryRun: true } })).data;
  assert.equal(pre.judges, 0);
  assert.match(pre.why.join(' '), /already/);
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { test_mode: false } } });
  const live = (await admin('/api/admin/send-judging', { body: { dryRun: true } })).data;
  assert.ok(live.judges > 5, 'judges whose link was only logged in test mode should be texted for real');
  assert.equal(live.twilio.ready, false);
  assert.ok(live.twilio.problems.some(p => /TWILIO_ACCOUNT_SID/.test(p)));
  const rowsBefore = (await refresh()).judging.length;
  const sent = (await admin('/api/admin/send-judging', { body: {} })).data;
  assert.equal(sent.texted, 0);
  assert.match(sent.results[0].status, /^not sent: .*TWILIO_ACCOUNT_SID/);
  assert.equal((await refresh()).judging.length, rowsBefore, 'no new judging rows');
  const retry = (await admin('/api/admin/send-judging', { body: { dryRun: true } })).data;
  assert.equal(retry.judges, live.judges, 'texts that failed are tried again next time');
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { test_mode: true } } });
  const t = (await admin('/api/admin/test-sms', { body: { to: '617-555-0100', real: true } })).data;
  assert.equal(t.ok, false);
  assert.match(t.status, /TWILIO_ACCOUNT_SID/);
  assert.ok(t.id > 0);
  const d = (await admin('/api/admin/check-delivery', { body: { id: t.id } })).data;
  assert.equal(d.checked, 0);
  console.log('       empty-send reason: ' + pre.why[0]);
  console.log('       without Twilio keys: ' + sent.results[0].status);
});

let tieCat = null;
await step('judges pick through their links; a split brings in a tiebreaker', async () => {
  const rows = A.judging;
  const judgesIn = cid => rows.filter(r => r.category_id === cid && r.role === 'judge').length;
  tieCat = rows.find(r => r.entries.length >= 3 && judgesIn(r.category_id) === 2).category_id;
  let split = false;
  for (const j of A.judges) {
    const v = (await judgeClient('/api/judge/' + j.token)).data;
    if (!v.rows || !v.rows.length) continue;
    const picks = {};
    // A tiebreaker row can appear mid-loop for a judge further down the list; skip it here.
    v.rows.filter(r => rows.some(x => x.id === r.id)).forEach(r => {
      const row = rows.find(x => x.id === r.id);
      picks[r.id] = row.category_id === tieCat && !split ? (split = true, r.entries[1]) : r.entries[0];
    });
    if (!Object.keys(picks).length) continue;
    const res = await judgeClient('/api/judge/' + j.token, { body: { picks } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.errors, []);
  }
  await refresh();
  const tb = A.judging.find(r => r.role === 'tiebreaker');
  assert.ok(tb, 'expected a tiebreaker row');
  assert.equal(tb.category_id, tieCat);
  assert.equal(tb.entries.length, 2);
  assert.ok(!A.judging.some(r => r.role === 'judge' && r.category_id === tieCat && r.judge_id === tb.judge_id));
  const text = A.log.find(l => /tiebreaker/.test(l.body));
  console.log('       tiebreak text: ' + text.body);
});

await step('locked picks cannot change; bad numbers are refused', async () => {
  const row = A.judging.find(r => r.role === 'judge' && r.category_id !== tieCat && r.pick !== null);
  const j = A.judges.find(x => x.id === row.judge_id);
  const other = row.entries.find(n => n !== row.pick);
  const r = await judgeClient('/api/judge/' + j.token, { body: { picks: { [row.id]: other } } });
  assert.match(r.data.errors.join(' '), /already decided/);
  const tb = A.judging.find(x => x.role === 'tiebreaker');
  const tbj = A.judges.find(x => x.id === tb.judge_id);
  const bad = await judgeClient('/api/judge/' + tbj.token, { body: { picks: { [tb.id]: 9999 } } });
  assert.match(bad.data.errors.join(' '), /not in/);
  const ok = await judgeClient('/api/judge/' + tbj.token, { body: { picks: { [tb.id]: tb.entries[1] } } });
  assert.deepEqual(ok.data.errors, []);
  assert.equal((await anon('/api/judge/not-a-token')).status, 404);
});

const catRows = cid => A.judging.filter(r => r.category_id === cid && r.role === 'judge');
const decidedCats = () => [...new Set(A.judging.filter(r => r.role === 'judge').map(r => r.category_id))]
  .filter(cid => cid !== tieCat && catRows(cid).length >= 2 && A.computed.results.find(x => x.categoryId === cid).status === 'decided');
async function confirmAll(cid) {
  for (const r of catRows(cid)) {
    const j = A.judges.find(x => x.id === r.judge_id);
    const res = await judgeClient('/api/judge/' + j.token, { body: { picks: { [r.id]: r.previous } } });
    assert.deepEqual(res.data.errors, []);
  }
  await refresh();
}
let lateNumber = null;
await step('a dish checked in after judging started reaches its judges, who must re-check', async () => {
  const cid = decidedCats()[0];
  const cname = A.categories.find(c => c.id === cid).display;
  const logBefore = A.log.length;
  const r = await table('/api/checkin', { body: { name: 'Very Late', kerberos: 'vlate', floor: 'B5', dishes: [{ dish: 'Last-minute tart', categories: [cid] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  lateNumber = r.data[0].number;
  await refresh();
  catRows(cid).forEach(row => {
    assert.ok(row.entries.includes(lateNumber));
    assert.equal(row.pick, null);
    assert.equal(row.recheck, true);
  });
  const newTexts = A.log.slice(0, A.log.length - logBefore);
  assert.equal(newTexts.length, catRows(cid).length);
  assert.ok(newTexts.every(t => t.body.includes('New dish #' + lateNumber + ' was added to ' + cname)));
  console.log('       late-dish text: ' + newTexts[0].body);
  assert.equal(A.computed.results.find(x => x.categoryId === cid).status, 'pending');
  const v = (await judgeClient('/api/judge/' + A.judges.find(x => x.id === catRows(cid)[0].judge_id).token)).data;
  assert.match(v.rows.find(x => x.id === catRows(cid)[0].id).note, /new dish/i);
  await confirmAll(cid);
  assert.equal(A.computed.results.find(x => x.categoryId === cid).status, 'decided');
});

await step('moving a dish to another category updates both judging lists', async () => {
  const from = A.entries.find(e => e.number === lateNumber);
  const oldCat = from.categories[0];
  const to = decidedCats().find(c => c !== oldCat);
  const r = await admin('/api/admin/rows/entries/' + from.id, { method: 'PATCH', body: { values: { categories: [to], name: 'Very Late and Friend' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await refresh();
  assert.ok(catRows(oldCat).every(x => !x.entries.includes(lateNumber) && x.pick !== null), 'old category keeps its decided picks');
  assert.ok(catRows(to).every(x => x.entries.includes(lateNumber) && x.recheck));
  assert.equal(A.entries.find(e => e.number === lateNumber).name, 'Very Late and Friend');
  await confirmAll(to);
});

await step('voting: web votes plus paper tallies', async () => {
  assert.equal((await anon('/api/vote', { body: { categoryId: 1, entry: 1 } })).status, 400, 'voting starts closed');
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { voting_open: true } } });
  const v = (await anon('/api/vote')).data;
  const pc = v.categories.find(c => /People/.test(c.name));
  const nums = A.entries.map(e => e.number);
  for (const n of [nums[3], nums[3], nums[3], nums[7], nums[7], nums[1]]) {
    const r = await anon('/api/vote', { body: { categoryId: pc.id, entry: n } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.match((await anon('/api/vote', { body: { categoryId: pc.id, entry: 99999 } })).data.error, /no dish/);
  const gra = A.categories.find(c => /GRA/.test(c.name));
  assert.equal((await anon('/api/vote', { body: { categoryId: gra.id, entry: nums[0] } })).status, 400, 'GRA choice is not on the voting page');
  await admin('/api/admin/rows/votes', { body: { values: { category_id: gra.id, entry: nums[5], votes: 1, source: 'paper' } } });
  const kids = A.categories.find(c => /Kids/.test(c.name));
  await admin('/api/admin/rows/votes', { body: { values: { category_id: kids.id, entry: nums[9], votes: 12, source: 'paper' } } });
  await refresh();
  const r = A.computed.results;
  assert.deepEqual(r.filter(x => x.categoryId === pc.id).map(x => x.entry), [nums[3], nums[7]]);
  assert.equal(r.find(x => x.categoryId === kids.id).entry, nums[9]);
});

await step('results: every category decided, floors ranked, kerberos listed', async () => {
  const pending = A.computed.results.filter(x => x.status === 'pending');
  assert.deepEqual(pending.map(x => x.category + ': ' + x.how), []);
  assert.ok(A.computed.standings[0].prize);
  assert.ok(A.computed.winnerKerberos.length > 5);
  const tie = A.computed.results.find(x => x.categoryId === tieCat);
  assert.match(tie.how, /^Tiebreaker judge/);
  console.log('       top floors: ' + A.computed.standings.slice(0, 3).map(s => s.rank + '. ' + s.floor + ' (' + s.wins + ')').join(', '));
});

await step('override wins and can be cleared', async () => {
  const target = A.computed.results.find(x => x.type === 'judged' && x.status === 'decided');
  const other = A.entries.find(e => e.number !== target.entry).number;
  await admin('/api/admin/override', { body: { categoryId: target.categoryId, place: 1, entry: other } });
  await refresh();
  let now = A.computed.results.find(x => x.categoryId === target.categoryId);
  assert.equal(now.entry, other);
  assert.equal(now.how, 'Set by organizer');
  await admin('/api/admin/override', { body: { categoryId: target.categoryId, place: 1, entry: null } });
  await refresh();
  now = A.computed.results.find(x => x.categoryId === target.categoryId);
  assert.equal(now.entry, target.entry);
});

await step('public results stay hidden until published, never show kerberos', async () => {
  assert.equal((await anon('/api/results')).data.public, false);
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { results_public: true } } });
  const r = (await anon('/api/results')).data;
  assert.equal(r.public, true);
  assert.ok(r.results.length > 10);
  assert.ok(!JSON.stringify(r).includes('kerberos'));
});

await step('past events stay viewable', async () => {
  const past = (await anon('/api/results?event=' + firstEventId)).data;
  assert.equal(past.public, true);
  const view = (await admin('/api/admin/data?event=' + firstEventId)).data;
  assert.equal(view.event.id, firstEventId);
  assert.equal(view.activeEventId, eventId);
});

await step('"ask judges" tiebreaks text the original judges, first answer settles it', async () => {
  await admin('/api/admin/settings', { method: 'PUT', body: { values: { tiebreak_method: 'ask judges' } } });
  // Make a fresh split: clear two picks in another category and re-pick differently.
  const cat = A.judging.find(r => r.role === 'judge' && r.category_id !== tieCat && r.entries.length >= 2 &&
    A.judging.filter(x => x.category_id === r.category_id && x.role === 'judge').length === 2).category_id;
  const rows = A.judging.filter(r => r.category_id === cat && r.role === 'judge');
  for (const r of rows) await admin('/api/admin/rows/judging/' + r.id, { method: 'PATCH', body: { values: { pick: '' } } });
  for (const [i, r] of rows.entries()) {
    const j = A.judges.find(x => x.id === r.judge_id);
    await judgeClient('/api/judge/' + j.token, { body: { picks: { [r.id]: r.entries[i % 2] } } });
  }
  await refresh();
  const finals = A.judging.filter(r => r.category_id === cat && r.role === 'final');
  assert.equal(finals.length, 2);
  const j0 = A.judges.find(x => x.id === finals[0].judge_id);
  await judgeClient('/api/judge/' + j0.token, { body: { picks: { [finals[0].id]: finals[0].entries[0] } } });
  await refresh();
  assert.ok(A.judging.find(r => r.id === finals[1].id).closed);
  assert.equal(A.computed.results.find(x => x.categoryId === cat).entry, finals[0].entries[0]);
});

await step('CSV exports download', async () => {
  for (const what of ['judges', 'entries', 'results', 'votes']) {
    const r = await admin('/api/admin/export/' + what + '.csv');
    assert.equal(r.status, 200);
    assert.ok(String(r.data).split('\n').length > 3, what);
  }
});

await step('switch the live event back', async () => {
  await admin('/api/admin/events/' + firstEventId + '/activate', { body: {} });
  await refresh();
  assert.equal(A.activeEventId, firstEventId);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
