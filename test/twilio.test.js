// Texting with a fake Twilio and a fake database: errors are explained, delivery is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSms, checkDelivery, twilioState, twilioHint } from '../src/competition.js';

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { sql, args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() { calls.push(stmt); return { meta: { last_row_id: calls.length } }; },
        async all() { calls.push(stmt); return { results: rows }; },
        async first() { calls.push(stmt); return null; },
      };
    },
  };
}

const SID = 'AC' + '0'.repeat(32);
const live = { test_mode: 'false', twilio_from: '(617) 555-0199' };

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return handler(String(url), init); };
  return fn(seen).finally(() => { globalThis.fetch = real; });
}
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('twilioState names each missing piece', () => {
  const t = twilioState({}, { test_mode: 'true', twilio_from: '' });
  assert.equal(t.ready, false);
  assert.equal(t.testMode, true);
  assert.equal(t.problems.length, 3);
  const bad = twilioState({ TWILIO_ACCOUNT_SID: 'SK123', TWILIO_AUTH_TOKEN: 'x' }, live);
  assert.match(bad.problems[0], /start with AC/);
  const ok = twilioState({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'x' }, live);
  assert.equal(ok.ready, true);
  assert.equal(ok.live, true);
  assert.equal(ok.from, '+16175550199');
  assert.equal(ok.sid, 'AC00...0000');
});

test('a Twilio error is explained in plain English and logged', async () => {
  const db = fakeDb();
  const env = { DB: db, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'tok' };
  await withFetch(() => reply(400, { code: 21608, message: 'The number is unverified.' }), async seen => {
    const r = await sendSms(env, 1, live, '+16175550100', 'hi', 'Test');
    assert.equal(r.ok, false);
    assert.match(r.status, /^not sent: Twilio trial accounts can only text numbers verified/);
    assert.match(r.status, /Twilio error 21608/);
    assert.equal(seen[0].init.method, 'POST');
    assert.match(String(seen[0].init.body), /From=%2B16175550199/);
  });
  assert.match(db.calls.at(-1).sql, /INSERT INTO sms_log/);
});

test('an accepted text waits for a delivery report; checkDelivery fills it in', async () => {
  const db = fakeDb();
  const env = { DB: db, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'tok' };
  await withFetch(() => reply(201, { sid: 'SM1', status: 'queued' }), async () => {
    const r = await sendSms(env, 1, live, '+16175550100', 'hi', 'Test');
    assert.equal(r.ok, true);
    assert.match(r.status, /waiting for delivery report/);
    assert.ok(r.id > 0);
  });

  const pending = fakeDb([
    { id: 7, sid: 'SM7', status: 'sent to Twilio, waiting for delivery report' },
    { id: 8, sid: 'SM8', status: 'sent to Twilio, waiting for delivery report' },
    { id: 9, sid: 'SM9', status: 'delivered' },
  ]);
  const env2 = { DB: pending, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'tok' };
  await withFetch(url => url.includes('SM7')
    ? reply(200, { status: 'undelivered', error_code: 30032, error_message: 'Toll-Free Number Has Not Been Verified' })
    : reply(200, { status: 'delivered' }), async seen => {
    const r = await checkDelivery(env2, 1);
    assert.equal(r.checked, 2, 'already-delivered texts are not checked again');
    assert.equal(seen.length, 2);
    assert.match(r.rows[0].status, /^not delivered: Your toll-free number is not verified yet/);
    assert.equal(r.rows[1].status, 'delivered');
  });
  const updates = pending.calls.filter(c => /UPDATE sms_log/.test(c.sql));
  assert.equal(updates.length, 2);
});

test('test mode only logs, and texts without Twilio keys say what is missing', async () => {
  const env = { DB: fakeDb() };
  await withFetch(() => { throw new Error('should not call Twilio'); }, async () => {
    const t = await sendSms(env, 1, { test_mode: 'true' }, '+16175550100', 'hi', 'Test');
    assert.equal(t.ok, true);
    assert.equal(t.status, 'TEST MODE (not sent)');
    const n = await sendSms(env, 1, live, '+16175550100', 'hi', 'Test');
    assert.equal(n.ok, false);
    assert.match(n.status, /TWILIO_ACCOUNT_SID secret is missing/);
    const none = await sendSms(env, 1, live, '', 'hi', 'Test');
    assert.match(none.status, /no phone number/);
  });
  assert.equal(twilioHint(99999, 'Something odd'), 'Something odd (Twilio error 99999)');
});
