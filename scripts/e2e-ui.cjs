// Browser check of the main agent flow (optional, needs Playwright):
//   npm start   (in another terminal)
//   npx -y playwright@1.56.1 install chromium   (once, if no browser is installed)
//   node scripts/e2e-ui.cjs [http://localhost:3000] [screenshots-dir]
// It starts and ends with "Reset demo data": run it on a demo server only.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3];
const assert = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); process.exitCode = 1; } else console.log(`ok - ${msg}`); };

const getJson = async (path) => (await fetch(URL_ + path)).json();

(async () => {
  // Start from the original backlog, whatever the earlier runs changed.
  const reset = await fetch(`${URL_}/api/demo/reset`, { method: 'POST' });
  assert(reset.ok && (await reset.json()).created === 30, 'demo data reset to the original 30 messages');
  const browser = await chromium.launch();
  // Guided tour: starts by itself on a first visit and walks through every step.
  const errors = [];
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  fresh.on('pageerror', (e) => errors.push(e.message));
  await fresh.goto(`${URL_}/`);
  await fresh.waitForSelector('.tour-pop:not(.loading)', { timeout: 8000 });
  const total = Number((await fresh.textContent('.tour-count')).match(/of (\d+)/)[1]);
  const titles = [];
  for (let i = 0; i < total; i++) {
    await fresh.waitForFunction((n) => document.querySelector('.tour-count')?.textContent.startsWith(`Step ${n} `) && !document.querySelector('.tour-pop.loading'), i + 1);
    titles.push(await fresh.textContent('#tourTitle'));
    if (OUT && /Conversations, not messages/.test(titles.at(-1))) { await fresh.waitForTimeout(400); await fresh.screenshot({ path: `${OUT}/tour.png` }); }
    const box = await fresh.$eval('.tour-highlight', (el) => getComputedStyle(el).display);
    if (i > 0 && i < total - 1 && box === 'none') errors.push(`tour step "${titles.at(-1)}" has nothing highlighted`);
    await fresh.click('.tour-next');
  }
  await fresh.waitForSelector('.tour-pop', { state: 'detached' });
  assert(total >= 19 && titles.includes('Built-in safety') && titles.includes('Incidents, not separate tickets'), `guided tour shows all ${total} steps`);
  assert(['What needs attention now', 'Assign and update from the list', 'Needs review'].every((t) => titles.includes(t)), 'the tour covers the banner, the row actions and Needs review');
  assert(await fresh.evaluate(() => localStorage.getItem('triage.tourDone') === '1'), 'tour is not shown again after finishing');
  await fresh.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem('triage.tourDone', '1'));
  let expect400 = false; // the bad-key check below triggers one on purpose
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !(expect400 && /status of 400/.test(m.text()))) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept('test reason'));

  await page.goto(`${URL_}/#/all`);
  await page.waitForSelector('.row');
  assert((await page.locator('.row').count()) >= 20, 'queue lists the imported conversations');
  assert((await page.textContent('.row:first-child')).includes('Critical'), 'most urgent first');
  assert(/Stripe payments failing \(4 customers/.test(await page.textContent('#attention .banner')), 'banner: the open Stripe incident is shown above the queue, with its 4 customers');
  const cards = await page.locator('#attention .card').allTextContents();
  assert(cards.length === 3 && cards.some((t) => /Sarah Martin.*3× no answer|3× no answer.*Sarah Martin/s.test(t)), 'cards: the 3 customers who wrote again without an answer');
  assert(await page.isDisabled('.row:first-child select[name=assignee]'), 'row controls are locked until you say who you are');
  const unassignedTile = Number(await page.textContent('.tile:has-text("Unassigned") .value'));
  await page.click('.tile:has-text("Unassigned")');
  await page.waitForTimeout(400);
  assert(unassignedTile === 24 && (await page.locator('.row').count()) === unassignedTile, 'a tile counts exactly the rows it opens (spam & test hidden in both)');
  await page.click('.tile:has-text("Open conversations")');
  await page.waitForTimeout(400);
  if (OUT) await page.screenshot({ path: `${OUT}/overview.png`, fullPage: false });

  await page.click('.row:has-text("Sarah Martin")');
  await page.waitForSelector('#drawer:not([hidden]) h2');
  const drawer = await page.textContent('#drawer');
  assert(/3 messages/.test(drawer) && /Deadline in 3d/.test(drawer), 'Sarah: 3 messages grouped, launch deadline shown');
  assert(!drawer.includes('null'), 'no "null" leaks into the UI');
  if (OUT) await page.screenshot({ path: `${OUT}/conversation.png` });

  await page.selectOption('#meSelect', 'Julien');
  await page.click('text=Assign to me');
  await page.waitForFunction(() => document.querySelector('#drawer').innerText.includes('Assigned to Julien'));
  await page.fill('textarea[name=note]', 'Asked her registrar for a screenshot of the DNS zone.');
  await page.click('.note-form button');
  await page.waitForFunction(() => document.querySelector('#drawer').innerText.includes('Asked her registrar'));
  assert(true, 'assign + internal note recorded in history');

  // Owner and status straight from the list.
  await page.click('#drawer button[aria-label=Close]');
  const marcRow = '.row:has-text("Marc Dupont")';
  const marcId = await page.getAttribute(marcRow, 'data-id');
  await page.selectOption(`${marcRow} select[name=assignee]`, 'Mehdi');
  await page.waitForFunction((sel) => document.querySelector(`${sel} select[name=status]`)?.value === 'in_progress', `.row[data-id="${marcId}"]`);
  await page.selectOption(`.row[data-id="${marcId}"] select[name=status]`, 'waiting_customer');
  await page.waitForFunction((sel) => document.querySelector(`${sel} select[name=status]`)?.value === 'waiting_customer', `.row[data-id="${marcId}"]`);
  const marc = await getJson(`/api/conversations/${marcId}`);
  assert(marc.assignee === 'Mehdi' && marc.status === 'waiting_customer' && marc.events.filter((e) => e.actor === 'Julien').length === 3,
    'assign and status changed from the list row, signed by the agent');
  assert(await page.isHidden('#drawer'), 'changing a row does not open the conversation');

  // Nothing is reset by loading the page again.
  await page.reload();
  await page.waitForSelector('.row');
  assert(await page.inputValue('.row:has-text("Sarah Martin") select[name=assignee]') === 'Julien'
    && await page.inputValue(`.row[data-id="${marcId}"] select[name=status]`) === 'waiting_customer', 'changes are kept after reloading the page');

  // Needs review: doubtful conversations, cleared one by one.
  await page.click('[data-view=review]');
  await page.waitForFunction(() => document.querySelector('#viewTitle').textContent === 'Needs review');
  await page.waitForTimeout(300);
  const toReview = (await getJson('/api/stats')).needsReview;
  assert(toReview === 7 && (await page.locator('.row').count()) === toReview, `Needs review lists the ${toReview} doubtful conversations`);
  assert(await page.isHidden('#attention'), 'the incident banner and cards stay out of the review view');
  const reviewText = await page.textContent('#list');
  assert(['No sender', 'Invalid email', 'Date guessed', 'Tried to steer the AI'].every((t) => reviewText.includes(t)), 'each one shows why it needs a check');
  if (OUT) await page.screenshot({ path: `${OUT}/review.png` });
  await page.click('.row:has-text("lina.haddad.com")');
  await page.waitForSelector('#drawer:not([hidden]) [data-tour=review] button');
  await page.click('#drawer button:has-text("Mark as checked")');
  await page.waitForFunction(() => document.querySelector('#drawer').innerText.includes('Marked as checked'));
  await page.click('#drawer button[aria-label=Close]');
  await page.waitForFunction((n) => document.querySelectorAll('#list .row').length === n, toReview - 1);
  assert(!(await page.textContent('#list')).includes('lina.haddad.com'), '"Mark as checked" removes it from Needs review');
  await page.click('[data-view=all]');
  await page.waitForSelector('#attention .banner');
  await page.click('#attention .banner a');
  await page.waitForFunction(() => document.querySelector('#viewTitle').textContent.startsWith('⚡'));
  assert((await page.locator('.row').count()) === 4, 'the banner opens the incident');
  await page.click('[data-view=all]');
  await page.waitForSelector('.row');

  await page.evaluate(() => fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'chat', from: 'Nina <nina@example.com>', message: 'My account was hacked, someone changed my email!' }) }));
  await page.waitForSelector('.toast', { timeout: 5000 });
  assert(true, 'a new critical message shows a live alert without reloading');

  await page.evaluate(() => fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'x@example.com', message: '<img src=x onerror="window.__xss=1"> how do I add a logo?' }) }));
  await page.waitForTimeout(800);
  assert(!(await page.evaluate(() => window.__xss === 1)), 'HTML inside a message is shown as text, never executed');

  // Settings: the AI is off, the key field is hidden text, a bad key is refused.
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsDrawer:not([hidden]) h2');
  assert((await page.textContent('#settingsDrawer')).includes('Off: rules only'), 'settings show the AI engine is off');
  assert((await page.getAttribute('#settingsDrawer [name=apiKey]', 'type')) === 'password', 'the API key field hides what is typed');
  await page.fill('#settingsDrawer [name=apiKey]', 'too-short');
  expect400 = true;
  await page.click('#settingsDrawer button:has-text("Save key")');
  await page.waitForSelector('.toast:has-text("does not look like an API key")');
  expect400 = false;
  assert((await page.inputValue('#settingsDrawer [name=apiKey]')) === '', 'the typed key is cleared from the page');
  await page.click('#settingsDrawer button:has-text("n8n workflow")');
  assert((await page.getAttribute('#settingsDrawer [name=n8nSecret]', 'type')) === 'password', 'the n8n option shows a hidden secret field');
  if (OUT) await page.screenshot({ path: `${OUT}/settings.png` });
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#scrim'), 'closing settings removes the dark backdrop');

  await page.goto(`${URL_}/#/incident/1`);
  await page.waitForTimeout(500);
  assert((await page.locator('.row').count()) === 4, 'incident view lists the 4 Stripe conversations');
  if (OUT) await page.screenshot({ path: `${OUT}/incident.png` });
  await page.click('#alertsBtn');
  await page.waitForTimeout(300);
  if (OUT) await page.screenshot({ path: `${OUT}/alerts.png` });
  await page.keyboard.press('Escape');

  // Reset demo data: asks first (accepted here), then back to the original backlog.
  await page.goto(`${URL_}/#/all`);
  await page.waitForSelector('.row');
  await page.click('#settingsBtn');
  await page.click('#settingsDrawer button:has-text("Reset demo data")');
  await page.waitForSelector('.toast:has-text("Demo data reset")');
  await page.waitForFunction(() => document.querySelector('.row') && !document.querySelector('#list').innerText.includes('Nina'));
  const all = await getJson('/api/conversations?status=all');
  assert(all.length === 26 && all.every((c) => !c.assignee && c.status === 'new') && await page.inputValue('.row:has-text("Sarah Martin") select[name=assignee]') === '',
    'Reset demo data brings back the 26 original conversations, unassigned');
  assert((await getJson('/api/notifications')).length === 7 && (await getJson('/api/stats')).needsReview === 7, 'alerts and Needs review start again from the backlog');
  assert(await page.isHidden('#settingsDrawer'), 'the settings panel closes after the reset');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(URL_);
  // Tour on a phone: the team list lives in the side menu.
  await mobile.waitForSelector('.tour-pop:not(.loading)', { timeout: 8000 });
  for (let i = 1; i < 10; i++) {
    await mobile.waitForFunction((n) => document.querySelector('.tour-count')?.textContent.startsWith(`Step ${n} `) && !document.querySelector('.tour-pop.loading'), i);
    if (await mobile.textContent('#tourTitle') === 'A queue per team') break;
    await mobile.click('.tour-next');
  }
  await mobile.waitForFunction(() => document.querySelector('#tourTitle')?.textContent === 'A queue per team' && !document.querySelector('.tour-pop.loading'));
  assert(await mobile.evaluate(() => document.querySelector('#sidebar').classList.contains('open')), 'on a phone the tour opens the team menu');
  await mobile.keyboard.press('Escape');
  await mobile.waitForSelector('.tour-pop', { state: 'detached' });
  await mobile.waitForSelector('.row');
  assert((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no horizontal scroll on a phone');
  if (OUT) await mobile.screenshot({ path: `${OUT}/mobile.png` });

  assert(errors.length === 0, `no browser errors ${errors.length ? JSON.stringify(errors) : ''}`);
  await browser.close();
})();
