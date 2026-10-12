import puppeteer from 'puppeteer-core';
const EXE = '/Users/stepan2/.cache/puppeteer/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', (e.message || '').slice(0, 300)));
await page.goto('http://localhost:5173/?seed=4242', { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__world !== undefined && window.__world.nav !== undefined, { timeout: 20000 });
await new Promise(r => setTimeout(r, 1200));
await page.evaluate(() => {
  const s = window.__game.scene.getScene('Game');
  s.hp = 100000; s.fireAcc = -1e12;
  const nb = s.layout.rooms.find((r) => !r.isStart);
  window.__nb = nb.id;
  s.player.body.reset(s.layout.rooms[0].cx, s.layout.rooms[0].cy);
  s.spawnEnemyAt(nb.cx, nb.cy, nb.id);
  const e = s.enemies.getChildren().find((x) => x.active);
  e.setData('hp', 2000);
});
await new Promise(r => setTimeout(r, 3000));
console.log(await page.evaluate(() => {
  const s = window.__game.scene.getScene('Game');
  const e = s.enemies.getChildren().find((x) => x.active);
  if (!e) return 'no-enemy';
  const h = e.getData('path');
  const direct = s.nav.findPath(e.x, e.y, s.player.x, s.player.y);
  return JSON.stringify({
    epos: [Math.round(e.x), Math.round(e.y)],
    ppos: [Math.round(s.player.x), Math.round(s.player.y)],
    vel: [Math.round(e.body.velocity.x), Math.round(e.body.velocity.y)],
    tKind: e.getData('tKind'), tId: e.getData('tId'),
    path: h ? { pts: h.pts ? h.pts.length : null, i: h.i, age: Math.round(h.age * 10) / 10, cd: h.cd } : null,
    budget: s.pathBudget,
    directLen: direct ? direct.length : null,
    touching: btoa(JSON.stringify(e.body.touching)).slice(0, 20)
  });
}));
await browser.close();
