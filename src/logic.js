// Pure competition logic: no database, no network. Shared by the Worker and the tests.

export const RESTRICTIONS = ['vegetarian', 'vegan', 'gluten-free', 'nut allergy', 'dairy-free', 'kosher', 'halal'];

export function splitList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
}

export function truthy(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null || v === undefined) return false;
  return /^(true|yes|y|1|x|on)$/i.test(String(v).trim());
}

export function capitalize(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "Most Creative {ingredient}" + "carrots" -> "Most Creative Carrots" */
export function displayCategory(name, ingredient) {
  return String(name).replace(/\{ingredient\}/gi, capitalize(ingredient)).trim();
}

/** Compare category names ignoring case, extra spaces and curly vs straight apostrophes. */
export function catKey(s) {
  return String(s || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Messy floor text -> floor code: "b3rd" -> B3, "Burton 1" -> B1, "C5 (GRA)" -> C5. '' when unclear. */
export function normalizeFloor(raw, floors = [], others = []) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return '';
  const all = floors.concat(others);
  const exact = all.find(f => f.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  const t = text.toUpperCase().replace(/\(.*?\)/g, ' ').trim();
  let m = t.match(/^(?:B|BURTON)\W*(\d)/);
  if (m) return 'B' + m[1];
  m = t.match(/^(?:C|CONNER|CONNOR)\W*(\d)/);
  if (m) return 'C' + m[1];
  m = t.match(/^([A-Z])\s*(\d)(?:ST|ND|RD|TH)?\b/);
  if (m) return m[1] + m[2];
  const loose = all.find(f => t.indexOf(f.toUpperCase()) === 0);
  return loose || '';
}

/** Any US phone format -> +1XXXXXXXXXX. '' when unclear. */
export function normalizePhone(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const s = typeof raw === 'number' ? String(Math.round(raw)) : String(raw).trim();
  const plus = s.charAt(0) === '+';
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  if (plus && digits.length >= 8) return '+' + digits;
  return '';
}

/** "Kerb@MIT.edu" -> "kerb". One kerberos only: anything after a space or comma is dropped. */
export function kerberosOf(text) {
  return String(text || '').trim().toLowerCase().split(/[\s,;/&]+/)[0].split('@')[0].replace(/[^a-z0-9_.-]/g, '');
}

/** True when someone typed more than one kerberos ("kerb1, kerb2", "kerb1 and kerb2"). */
export function hasMultipleKerberos(text) {
  return /[,;/&]|\S\s+\S/.test(String(text || '').trim());
}

/** Free-text dietary notes -> restriction tags. Anything we can't map becomes "other" (flagged for a human). */
export function parseRestrictions(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t || /^(none|no|nope|n\/?a|nah|nothing|-)\W*$/.test(t)) return [];
  const tags = [];
  const rules = [
    [/vegan/, 'vegan'],
    [/vegetarian|veggie/, 'vegetarian'],
    [/gluten|celiac|coeliac/, 'gluten-free'],
    [/nut|cashew|walnut|pecan|almond|pistachio|macadamia|hazelnut/, 'nut allergy'],
    [/dairy|lactose|milk/, 'dairy-free'],
    [/kosher/, 'kosher'],
    [/halal/, 'halal'],
  ];
  rules.forEach(([re, tag]) => { if (re.test(t) && !tags.includes(tag)) tags.push(tag); });
  if (/sesame|soy|egg|shellfish|shrimp|fish|meat|pork|beef|chicken|corn|fruit|apple|carrot|potato|sulfite|fodmap/.test(t) || !tags.length) tags.push('other');
  return tags;
}

/** Loose category text ("Performance (~2pm)") -> the matching category, or null. */
export function matchCategory(text, categories) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(text);
  if (!n) return null;
  const exact = categories.find(c => norm(c.name) === n);
  if (exact) return exact;
  let best = null, bestLen = 0, tie = false;
  categories.forEach(c => {
    const cn = norm(c.name);
    let k = 0;
    while (k < cn.length && k < n.length && cn[k] === n[k]) k++;
    if (k > bestLen) { best = c; bestLen = k; tie = false; } else if (k === bestLen && k > 0) tie = true;
  });
  return bestLen >= 6 && !tie ? best : null;
}

/** Can this judge eat this category? Judges with no tags can judge anything; "all" categories suit everyone. */
export function dietOk(judge, cat) {
  const tags = (judge.tags || []).filter(t => t !== 'other');
  if (!tags.length) return true;
  const ok = (cat.ok || []).map(s => s.toLowerCase());
  if (ok.includes('all')) return true;
  return tags.every(t => ok.includes(t));
}

function compareArrays(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return 0;
}

/**
 * Assigns judges to categories.
 * judges: [{id, name, floor, tags, prefs: [categoryId], locked, assigned: [categoryId]}]
 * categories: [{id, name, ok}]
 * opts: {perCat, maxPerJudge, diffFloors}
 * Returns {assigned: [[categoryId]] parallel to judges, shortages, overloaded, unassigned}.
 */
export function assignJudges(judges, categories, opts) {
  const per = Math.max(1, Number(opts.perCat) || 2);
  const max = Math.max(1, Number(opts.maxPerJudge) || 2);
  const ids = categories.map(c => c.id);
  const assigned = judges.map(j => (j.locked ? (j.assigned || []).filter(c => ids.includes(c)) : []));
  const inCat = {};
  categories.forEach(c => { inCat[c.id] = []; });
  assigned.forEach((cats, i) => cats.forEach(c => inCat[c].push(i)));

  const eligible = c => judges.filter(j => !j.locked && dietOk(j, c)).length;
  const wanted = c => judges.filter(j => (j.prefs || []).includes(c.id)).length;
  const order = categories.slice().sort((a, b) => eligible(a) - eligible(b) || wanted(a) - wanted(b));

  const overloaded = [];
  const pick = (cat, limit, prefOnly) => {
    const usedFloors = inCat[cat.id].map(i => judges[i].floor).filter(Boolean);
    let best = -1, bestScore = null;
    judges.forEach((j, i) => {
      if (j.locked || assigned[i].includes(cat.id) || assigned[i].length >= limit || !dietOk(j, cat)) return;
      if (prefOnly && !(j.prefs || []).includes(cat.id)) return;
      if (opts.diffFloors && j.floor && usedFloors.includes(j.floor)) return;
      const score = [(j.prefs || []).includes(cat.id) ? 0 : 1, assigned[i].length, j.floor ? 0 : 1, i];
      if (!bestScore || compareArrays(score, bestScore) < 0) { best = i; bestScore = score; }
    });
    return best;
  };

  // Pass 1 gives judges categories they asked for; pass 2 fills the rest; pass 3 lets a
  // few judges take one extra category so no category is left short.
  [[max, true], [max, false], [max + 1, false]].forEach(([limit, prefOnly], pass) => {
    for (let round = 0; round < per; round++) {
      order.forEach(cat => {
        if (inCat[cat.id].length > round) return;
        const i = pick(cat, limit, prefOnly);
        if (i < 0) return;
        assigned[i].push(cat.id);
        inCat[cat.id].push(i);
        if (pass === 2 && !overloaded.includes(judges[i].name)) overloaded.push(judges[i].name);
      });
    }
  });

  return {
    assigned,
    shortages: categories.filter(c => inCat[c.id].length < per).map(c => ({ category: c.name, have: inCat[c.id].length, need: per })),
    overloaded,
    unassigned: judges.filter((j, i) => !assigned[i].length).map(j => j.name),
  };
}

/**
 * Decides one judged category from its judging rows.
 * rows: [{role: 'judge'|'tiebreaker'|'final', judge, pick, closed}]
 */
export function decideCategory(rows) {
  const judges = rows.filter(r => r.role === 'judge');
  if (!judges.length) return { status: 'unjudged' };
  const pending = judges.filter(r => r.pick === null || r.pick === undefined || r.pick === '');
  if (pending.length) return { status: 'waiting', waitingOn: pending.map(r => r.judge) };
  const counts = {};
  judges.forEach(r => { counts[r.pick] = (counts[r.pick] || 0) + 1; });
  const top = Math.max(...Object.values(counts));
  const leaders = Object.keys(counts).filter(k => counts[k] === top).map(Number).sort((a, b) => a - b);
  if (leaders.length === 1) {
    const method = judges.length === 1 ? "Judge's pick" : (top === judges.length ? 'Judges agreed' : 'Most judges');
    return { status: 'decided', winner: leaders[0], method };
  }
  const extra = rows.filter(r => r.role === 'tiebreaker' || r.role === 'final');
  const answered = extra.find(r => r.pick !== null && r.pick !== undefined && r.pick !== '');
  if (answered) {
    return {
      status: 'decided', winner: Number(answered.pick),
      method: answered.role === 'tiebreaker' ? 'Tiebreaker judge (' + answered.judge + ')' : 'Judges agreed after a tie',
    };
  }
  return { status: extra.length ? 'tiebreak-sent' : 'tie', finalists: leaders, waitingOn: extra.filter(r => !r.closed).map(r => r.judge) };
}

/** votes: [{entry, votes}] -> [{entry, votes}] highest first */
export function tallyVotes(votes) {
  const counts = {};
  votes.forEach(v => {
    const n = Number(v.entry);
    if (!n) return;
    const w = v.votes === '' || v.votes === null || v.votes === undefined ? 1 : Number(v.votes) || 0;
    counts[n] = (counts[n] || 0) + w;
  });
  return Object.keys(counts).map(k => ({ entry: Number(k), votes: counts[k] }))
    .filter(x => x.votes > 0)
    .sort((a, b) => b.votes - a.votes || a.entry - b.entry);
}

/** winners: [{floor, entry, category}] -> [{rank, floor, wins, prize, entries}], ties share a rank. */
export function computeStandings(winners, floors, topN) {
  const byFloor = {};
  floors.forEach(f => { byFloor[f] = []; });
  winners.forEach(w => { if (byFloor[w.floor]) byFloor[w.floor].push(w); });
  const list = floors.map(f => ({ floor: f, wins: byFloor[f].length, entries: byFloor[f] }))
    .sort((a, b) => b.wins - a.wins || floors.indexOf(a.floor) - floors.indexOf(b.floor));
  let rank = 0;
  list.forEach((row, i) => {
    if (i === 0 || row.wins !== list[i - 1].wins) rank = i + 1;
    row.rank = rank;
    row.prize = row.wins > 0 && rank <= topN;
  });
  return list;
}

/**
 * Picks a tiebreaker: not already judging the category, diet OK, has a phone, not opted out.
 * Prefers someone whose floor has no finalist, then the least busy.
 */
export function chooseTiebreaker(judges, cat, inCatJudgeIds, finalistFloors, load, avoidOwn) {
  return judges
    .filter(j => j.phone && !j.skipTiebreak && !inCatJudgeIds.includes(j.id) && dietOk(j, cat))
    .filter(j => !avoidOwn || !finalistFloors.includes(j.floor))
    .sort((a, b) => compareArrays(
      [finalistFloors.includes(a.floor) ? 1 : 0, load(a.id), a.name],
      [finalistFloors.includes(b.floor) ? 1 : 0, load(b.id), b.name]))[0] || null;
}

export function entryList(nums) {
  return nums.map(n => '#' + n).join(', ');
}

/** Minimal CSV parser (quotes, commas, newlines in quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

export function toCsv(rows) {
  return rows.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

export const DEFAULT_SETTINGS = {
  ingredient: 'Carrot',
  floors: 'B1, B2, B3, B4, B5, C1, C2, C3, C4, C5',
  other_groups: 'Alumni, Staff, Guest',
  judges_per_category: '2',
  max_categories_per_judge: '2',
  cojudges_different_floors: 'true',
  avoid_own_floor: 'false',
  tiebreak_method: 'third judge',
  entry_numbers: 'auto',
  first_entry_number: '1',
  max_categories_per_dish: '1',
  checkin_pin: '',
  checkin_open: 'true',
  signup_open: 'true',
  voting_open: 'false',
  results_public: 'false',
  top_floors: '3',
  special_counts: 'true',
  test_mode: 'true',
  twilio_from: '',
  organizer_phone: '',
};

export const DEFAULT_CATEGORIES = [
  // [kind, name, ok_for, web_voting, places, notes]
  ['judged', 'Cakes/breads', 'vegetarian'],
  ['judged', 'Pies/tarts', 'vegetarian'],
  ['judged', 'Cookies', 'vegetarian'],
  ['judged', 'Frozen', 'vegetarian, nut allergy, gluten-free'],
  ['judged', 'Other sweets', 'vegetarian'],
  ['judged', 'Stovetop', ''],
  ['judged', 'Sliced', 'vegetarian, vegan, gluten-free, nut allergy, dairy-free'],
  ['judged', 'Whole', 'vegetarian, vegan, gluten-free, nut allergy, dairy-free'],
  ['judged', 'Raw', 'vegetarian, vegan, gluten-free, nut allergy, dairy-free'],
  ['judged', 'Drinks', 'vegetarian, gluten-free, nut allergy'],
  ['judged', 'Microwave', 'vegetarian'],
  ['judged', 'Savory', ''],
  ['judged', 'Umami', ''],
  ['judged', 'Spicy', ''],
  ['judged', 'Looks/shaped like an apple', 'vegetarian'],
  ['judged', 'General art', 'all', 0, 1, 'Judged on looks, so any judge works.'],
  ['judged', 'Most Creative {ingredient}', 'vegetarian'],
  ['judged', 'Craziest {ingredient}', 'vegetarian'],
  ['judged', "Would've been better without the {ingredient}", 'vegetarian'],
  ['judged', 'Vegan', 'vegan, vegetarian, dairy-free'],
  ['judged', 'Kosher', 'kosher, vegetarian'],
  ['judged', 'Gluten free', 'gluten-free, vegetarian'],
  ['judged', 'Performance (must be available ~2pm)', 'all', 0, 1, 'Not eaten, so any judge works.'],
  ['special', "People's Choice", '', 1, 2, 'Second place is the runner-up.'],
  ['special', "Kids' Choice", '', 1, 1, 'Kids vote on the page, or add paper tallies.'],
  ['special', "GRA's Choice", '', 0, 1, "Add the GRAs' pick as a tally."],
  ['special', "Alumni's Choice", '', 1, 1, ''],
  ['special', "Dog's Choice", '', 0, 1, 'Add the pick as a tally.'],
];
