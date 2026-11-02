// Unit tests for the pure competition rules. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFloor, normalizePhone, parseRestrictions, displayCategory, matchCategory, assignJudges, decideCategory,
  tallyVotes, computeStandings, chooseTiebreaker, parseCsv, toCsv, dietOk,
} from '../src/logic.js';

const floors = ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5'];

test('floors', () => {
  const f = s => normalizeFloor(s, floors, ['Alumni']);
  assert.equal(f('b3rd'), 'B3');
  assert.equal(f('Burton 1'), 'B1');
  assert.equal(f('Conner 2'), 'C2');
  assert.equal(f('C5 (GRA)'), 'C5');
  assert.equal(f('alumni'), 'Alumni');
  assert.equal(f(1), '');
});

test('phones', () => {
  assert.equal(normalizePhone(6175550199), '+16175550199');
  assert.equal(normalizePhone('617-555-0142'), '+16175550142');
  assert.equal(normalizePhone('+1 (617) 555-1234'), '+16175551234');
  assert.equal(normalizePhone('555'), '');
});

test('restrictions', () => {
  assert.deepEqual(parseRestrictions('None'), []);
  assert.deepEqual(parseRestrictions('No!'), []);
  assert.deepEqual(parseRestrictions('Celiac Disease (gluten free)'), ['gluten-free']);
  assert.deepEqual(parseRestrictions('Some nuts (cashews, pistachios, macadamia nuts, pine nuts, Brazil nuts)'), ['nut allergy']);
  assert.deepEqual(parseRestrictions('nuts (except cashew) and sesame'), ['nut allergy', 'other']);
  assert.deepEqual(parseRestrictions('Can have eggs, chicken, fish, but no other meat'), ['other']);
});

test('category names', () => {
  assert.equal(displayCategory('Craziest {ingredient}', 'potato'), 'Craziest Potato');
  const cats = [{ id: 1, name: 'Performance (must be available ~2pm)' }, { id: 2, name: 'Pies/tarts' }];
  assert.equal(matchCategory('Performance (~2pm)', cats).id, 1);
  assert.equal(matchCategory('pies/tarts', cats).id, 2);
  assert.equal(matchCategory('Pe', cats), null);
});

test('assignment keeps co-judges on different floors and respects diets', () => {
  const cats = [{ id: 1, name: 'Cookies', ok: ['vegetarian'] }, { id: 2, name: 'Frozen', ok: ['nut allergy'] }, { id: 3, name: 'Savory', ok: [] }];
  const judges = [
    { id: 1, name: 'A', floor: 'B1', tags: [], prefs: [1] },
    { id: 2, name: 'B', floor: 'B1', tags: [], prefs: [1] },
    { id: 3, name: 'C', floor: 'C2', tags: ['nut allergy'], prefs: [] },
    { id: 4, name: 'D', floor: 'C3', tags: [], prefs: [3] },
    { id: 5, name: 'E', floor: 'B4', tags: [], prefs: [] },
  ];
  const r = assignJudges(judges, cats, { perCat: 2, maxPerJudge: 2, diffFloors: true });
  const byCat = {};
  r.assigned.forEach((list, i) => list.forEach(c => (byCat[c] = byCat[c] || []).push(judges[i])));
  Object.values(byCat).forEach(list => assert.equal(new Set(list.map(j => j.floor)).size, list.length));
  Object.keys(byCat).forEach(c => byCat[c].forEach(j => assert.ok(dietOk(j, cats.find(x => x.id === Number(c))))));
  assert.deepEqual(r.shortages, []);
  assert.ok(r.assigned[0].includes(1), 'A asked for Cookies');
  assert.ok(!r.assigned[2].includes(1) && !r.assigned[2].includes(3), 'C (nut allergy) only gets Frozen');
});

test('locked judges keep their categories', () => {
  const cats = [{ id: 1, name: 'X', ok: [] }, { id: 2, name: 'Y', ok: [] }];
  const judges = [{ id: 1, name: 'A', floor: 'B1', tags: [], prefs: [], locked: true, assigned: [2] }, { id: 2, name: 'B', floor: 'B2', tags: [], prefs: [] }];
  const r = assignJudges(judges, cats, { perCat: 1, maxPerJudge: 2, diffFloors: true });
  assert.deepEqual(r.assigned[0], [2]);
});

test('deciding a category', () => {
  assert.equal(decideCategory([{ role: 'judge', judge: 'x', pick: 3 }, { role: 'judge', judge: 'y', pick: null }]).status, 'waiting');
  assert.equal(decideCategory([{ role: 'judge', pick: 3 }, { role: 'judge', pick: 3 }]).winner, 3);
  const tie = decideCategory([{ role: 'judge', pick: 3 }, { role: 'judge', pick: 8 }]);
  assert.equal(tie.status, 'tie');
  assert.deepEqual(tie.finalists, [3, 8]);
  assert.equal(decideCategory([{ role: 'judge', pick: 3 }, { role: 'judge', pick: 8 }, { role: 'tiebreaker', judge: 'z', pick: null }]).status, 'tiebreak-sent');
  assert.equal(decideCategory([{ role: 'judge', pick: 3 }, { role: 'judge', pick: 8 }, { role: 'tiebreaker', judge: 'z', pick: 8 }]).winner, 8);
  assert.equal(decideCategory([{ role: 'judge', pick: 3 }, { role: 'judge', pick: 8 }, { role: 'judge', pick: 8 }]).method, 'Most judges');
});

test('votes and standings', () => {
  assert.deepEqual(tallyVotes([{ entry: 9, votes: 1 }, { entry: 9 }, { entry: 4, votes: 5 }]), [{ entry: 4, votes: 5 }, { entry: 9, votes: 2 }]);
  const s = computeStandings([{ floor: 'C2' }, { floor: 'C2' }, { floor: 'B2' }, { floor: 'C5' }, { floor: 'Alumni' }], floors, 2);
  assert.deepEqual(s.slice(0, 3).map(x => [x.floor, x.rank, x.prize]), [['C2', 1, true], ['B2', 2, true], ['C5', 2, true]]);
  assert.equal(s[3].prize, false);
});

test('tiebreaker choice avoids current judges and finalist floors', () => {
  const judges = [
    { id: 1, name: 'A', floor: 'C2', phone: '+1', tags: [] },
    { id: 2, name: 'B', floor: 'B1', phone: '+1', tags: [] },
    { id: 3, name: 'C', floor: 'B3', phone: '+1', tags: [] },
    { id: 4, name: 'D', floor: 'B4', phone: '', tags: [] },
  ];
  const tb = chooseTiebreaker(judges, { ok: [] }, [3], ['C2'], () => 0, false);
  assert.equal(tb.name, 'B');
});

test('csv round trip', () => {
  const rows = [['Name', 'Notes'], ['Sam, Alex', 'said "yum"\nthen left']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('assignment leaves backups once every category has its judges', () => {
  const cats = [{ id: 1, name: 'A', ok: ['all'] }, { id: 2, name: 'B', ok: ['all'] }];
  const judges = ['B1', 'B2', 'B3', 'B4', 'B5', 'C1'].map((floor, i) => ({ id: i + 1, name: 'J' + i, floor, tags: [], prefs: [] }));
  const r = assignJudges(judges, cats, { perCat: 2, maxPerJudge: 2, diffFloors: true });
  assert.deepEqual(r.shortages, []);
  assert.equal(r.assigned.filter(a => a.length).length, 2, 'two judges cover both categories');
  assert.equal(r.unassigned.length, 4);
});

test('backups fill short categories first, then join a preferred or random one', async () => {
  const { planBackups } = await import('../src/logic.js');
  const cats = [
    { id: 1, name: 'Cookies', ok: ['vegetarian'], members: [10], floors: ['B1'] }, // one judge so far
    { id: 2, name: 'Pies', ok: ['vegetarian'], members: [11, 12], floors: ['B2', 'B3'] },
    { id: 3, name: 'Vegan', ok: ['vegan'], members: [], floors: [] }, // nobody yet
  ];
  const regulars = [
    { id: 10, name: 'A', floor: 'B1', tags: [], prefs: [], load: 1, backup: false },
    { id: 11, name: 'B', floor: 'B2', tags: [], prefs: [], load: 1, backup: false },
    { id: 12, name: 'C', floor: 'B3', tags: [], prefs: [], load: 1, backup: false },
  ];
  const judges = regulars.concat([
    { id: 23, name: 'Anyone', floor: 'C3', tags: [], prefs: [], load: 0, backup: true },
    { id: 20, name: 'Same floor', floor: 'B1', tags: [], prefs: [1], load: 0, backup: true },
    { id: 21, name: 'Vegan', floor: 'C1', tags: ['vegan'], prefs: [], load: 0, backup: true },
    { id: 22, name: 'Likes pies', floor: 'C2', tags: [], prefs: [2], load: 0, backup: true },
  ]);
  const opts = { perCat: 2, maxPerJudge: 2, diffFloors: true, rand: () => 0 };
  const r = planBackups({ judges, categories: cats, ...opts });
  const where = id => r.adds.filter(a => a.judgeId === id).map(a => [a.categoryId, a.reason]);
  assert.deepEqual(where(23), [[1, 'gap']], 'a backup fills the Cookies gap');
  assert.ok(!where(20).some(([c]) => c === 1), 'co-judges stay on different floors');
  assert.deepEqual(r.adds.filter(a => a.categoryId === 3).map(a => a.judgeId).sort(), [20, 21], 'Vegan gets two backups');
  assert.deepEqual(where(22), [[2, 'preferred']], 'a spare backup joins a category they asked for');
  assert.deepEqual(r.short, []);

  const late = planBackups({ judges, categories: cats, ...opts, only: 22 });
  assert.ok(late.adds.every(a => a.judgeId === 22));
  assert.deepEqual(late.adds.map(a => [a.categoryId, a.reason]), [[1, 'gap'], [3, 'gap']], 'a late backup fills gaps (up to the max) before a preferred category');

  const alone = planBackups({ judges: regulars, categories: cats, ...opts, maxPerJudge: 1 });
  assert.deepEqual(alone.adds, []);
  assert.deepEqual(alone.short.map(c => [c.name, c.have]), [['Cookies', 1], ['Vegan', 0]], 'Cookies is judged by its one judge');
});
