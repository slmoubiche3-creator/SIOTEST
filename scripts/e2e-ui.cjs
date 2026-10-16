// Browser check of the main agent flow (optional, needs Playwright):
//   npm start   (in another terminal, fresh database)
//   npx -y playwright@1.56.1 install chromium   (once, if no browser is installed)
//   node scripts/e2e-ui.cjs [http://localhost:3000] [screenshots-dir]
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3];
const assert = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); process.exitCode = 1; } else console.log(`ok - ${msg}`); };

(async () => {
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
  assert(total >= 15 && titles.includes('Built-in safety') && titles.includes('Incidents, not separate tickets'), `guided tour shows all ${total} steps`);
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

  await page.click('#drawer button[aria-label=Close]');
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

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(URL_);
  // Tour on a phone: the team list lives in the side menu.
  await mobile.waitForSelector('.tour-pop:not(.loading)', { timeout: 8000 });
  for (let i = 1; i <= 3; i++) {
    await mobile.waitForFunction((n) => document.querySelector('.tour-count')?.textContent.startsWith(`Step ${n} `) && !document.querySelector('.tour-pop.loading'), i);
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
