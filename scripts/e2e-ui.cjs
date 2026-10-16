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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

  await page.goto(`${URL_}/#/incident/1`);
  await page.waitForTimeout(500);
  assert((await page.locator('.row').count()) === 4, 'incident view lists the 4 Stripe conversations');
  if (OUT) await page.screenshot({ path: `${OUT}/incident.png` });
  await page.click('#alertsBtn');
  await page.waitForTimeout(300);
  if (OUT) await page.screenshot({ path: `${OUT}/alerts.png` });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(URL_);
  await mobile.waitForSelector('.row');
  assert((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no horizontal scroll on a phone');
  if (OUT) await mobile.screenshot({ path: `${OUT}/mobile.png` });

  assert(errors.length === 0, `no browser errors ${errors.length ? JSON.stringify(errors) : ''}`);
  await browser.close();
})();
