// Clicks through every page in a real browser against a running site (npm run dev).
//   ADMIN_PASSWORD=... node test/ui-smoke.cjs [screenshot-dir]
// Needs Playwright (npm i -D playwright && npx playwright install chromium).
// Creates its own "UI test" event and switches the live event back afterwards.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const PASSWORD = process.env.ADMIN_PASSWORD || 'test-password';
const OUT = process.argv[2] || 'test-output';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const watch = (page, name) => {
    page.on('pageerror', e => problems.push(name + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/favicon|cdnjs|ERR_TUNNEL|401/.test(m.text())) problems.push(name + ' console: ' + m.text()); });
  };
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const expectVisible = async (page, sel, what) => {
    try { await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }); } catch (e) { problems.push(what + ' (' + sel + ' not visible)'); }
  };

  // --- admin: login, new event --------------------------------------------------
  const admin = await desk.newPage(); watch(admin, 'admin');
  await admin.goto(BASE + '/admin');
  await admin.fill('#password', PASSWORD);
  await admin.click('#loginBtn');
  await expectVisible(admin, '#app', 'admin login');
  const before = await admin.evaluate(() => api('/api/admin/data').then(d => d.activeEventId));
  await admin.click('#newEventBtn');
  await admin.fill('#neName', 'UI test ' + Date.now());
  await admin.fill('#neIngredient', 'potato');
  await admin.selectOption('#neCopy', 'defaults');
  await admin.click('#neCreate');
  await admin.waitForSelector('text=Craziest Potato');
  await shot(admin, 'admin-categories');

  // Add a judged category and rename it inline.
  await admin.click('text=+ Add judged category');
  await admin.click('td.cell:has-text("New category")');
  await admin.fill('td.cell input', 'Hash browns');
  await admin.keyboard.press('Enter');
  await admin.waitForSelector('td:has-text("Hash browns")');

  // --- judges sign up on their phones ----------------------------------------------
  const people = [['Avery Judge', 'avery', 'B1'], ['Blake Judge', 'blake', 'C2'], ['Casey Judge', 'casey', 'B3'], ['Drew Judge', 'drew', 'C4']];
  for (const [i, [name, kerb, floor]] of people.entries()) {
    const p = await phone.newPage(); watch(p, 'signup');
    await p.goto(BASE + '/signup');
    await p.waitForSelector('#form:not(.hidden)');
    await p.fill('#name', name); await p.fill('#email', kerb + '@mit.edu'); await p.fill('#phone', '617-555-01' + (10 + i));
    await p.click(`#floors .chip:text-is("${floor}")`);
    await p.click('#cats .chip:text-is("Hash browns")');
    if (i === 0) await shot(p, 'signup');
    await p.click('#submit');
    await expectVisible(p, '#done', 'signup ' + name);
    await p.close();
  }

  // --- admin assigns ----------------------------------------------------------------
  await admin.click('nav.tabs button:text-is("Overview")');
  await admin.click('button:text-is("Assign judges")');
  await expectVisible(admin, 'pre.report', 'assignment report');
  await admin.click('nav.tabs button:text-is("Judges")');
  await admin.waitForSelector('td:has-text("Avery Judge")');
  await shot(admin, 'admin-judges');
  const pin = await admin.evaluate(() => api('/api/admin/data').then(d => d.settings.checkin_pin));

  // --- check-in laptop --------------------------------------------------------------
  const laptop = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const desk2 = await laptop.newPage(); watch(desk2, 'checkin');
  await desk2.goto(BASE + '/checkin');
  await desk2.fill('#pin', pin);
  await desk2.click('#pinBtn');
  await desk2.waitForSelector('#formCard:not(.hidden)');
  const bakers = [['Riley Baker', 'rbaker', 'C2', 'Loaded hash browns'], ['Jordan and Sky', 'jordan', 'B2', 'Sweet potato hash'], ['Morgan Baker', 'mbaker', 'C5', 'Hash brown waffle']];
  for (const [i, [name, kerb, floor, dish]] of bakers.entries()) {
    await desk2.fill('#name', name); await desk2.fill('#kerberos', kerb);
    await desk2.click(`#floors .chip:text-is("${floor}")`);
    await desk2.fill('.dish .dishName', dish);
    await desk2.click('.dish .chip:text-is("Hash browns")');
    if (i === 0) await shot(desk2, 'checkin-form');
    await desk2.click('#submit');
    await expectVisible(desk2, '#doneCard', 'check-in ' + name);
    if (i === 0) await shot(desk2, 'checkin-done');
    await desk2.click('#next');
  }

  // --- two judges check in on their phones -----------------------------------------------
  for (const [i, name] of ['Avery', 'Blake'].entries()) {
    const p = await phone.newPage(); watch(p, 'here');
    await p.goto(BASE + '/here');
    await p.fill('#q', name);
    await p.click('.match:has-text("' + name + ' Judge")');
    await expectVisible(p, '#doneCard', 'judge check-in ' + name);
    if (i === 0) await shot(p, 'judge-checkin');
    await p.close();
  }

  // --- text the judges ----------------------------------------------------------------
  await admin.click('nav.tabs button:text-is("Overview")');
  await admin.click('button:text-is("Start judging")');
  await expectVisible(admin, '.send-panel .msg', 'send preview');
  await shot(admin, 'admin-send-preview');
  await admin.click('.send-panel button:has-text("Log ")');
  await admin.waitForSelector('.send-panel .msg:has-text("Logged")');
  await shot(admin, 'admin-overview');
  // The test-text box reports Twilio problems right next to the button.
  await admin.fill('.checks ~ .toolbar input', '617-555-0100');
  await admin.click('.checks ~ .toolbar button:text-is("Send")');
  await admin.waitForSelector('section:has(.checks) .msg.error');
  await shot(admin, 'admin-test-text');
  await admin.click('nav.tabs button:text-is("Texts")');
  const links = await admin.$$eval('td a[href*="/j/"]', as => as.map(a => a.href));
  if (links.length < 2) problems.push('expected judging links in the Texts tab, got ' + links.length);
  await shot(admin, 'admin-texts');

  // --- judges tap their favorite --------------------------------------------------------
  for (const [i, link] of links.entries()) {
    const p = await phone.newPage(); watch(p, 'judge');
    await p.goto(link);
    await p.waitForSelector('.pick');
    await p.click('.pick >> nth=' + (i === 0 ? 1 : 0));
    if (i === 0) await shot(p, 'judge-before');
    await p.click('#submit');
    await p.waitForSelector('#msg.ok');
    if (i === 0) await shot(p, 'judge-after');
    await p.close();
  }

  // --- voting and results ---------------------------------------------------------------
  await admin.click('nav.tabs button:text-is("Overview")');
  await admin.click('label.switch:has-text("Voting is open") input');
  await admin.waitForTimeout(500);
  const voter = await phone.newPage(); watch(voter, 'vote');
  await voter.goto(BASE + '/vote');
  await voter.waitForSelector('#form:not(.hidden)');
  await voter.fill('#entry', '1');
  await voter.click('#submit');
  await expectVisible(voter, '#msg.ok', 'vote');
  await shot(voter, 'vote');
  await admin.click('label.switch:has-text("Results are public") input');
  await admin.waitForTimeout(500);
  await admin.click('nav.tabs button:text-is("Results")');
  await shot(admin, 'admin-results');
  const pub = await desk.newPage(); watch(pub, 'results');
  await pub.goto(BASE + '/results');
  await pub.waitForSelector('.win');
  await shot(pub, 'results');

  // Put the live event back the way it was.
  await admin.evaluate(id => api('/api/admin/events/' + id + '/activate', { body: {} }), before);
  await browser.close();
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'UI smoke test passed');
  if (problems.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
