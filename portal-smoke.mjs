import puppeteer from 'puppeteer';

const BASE = 'http://localhost:5173';
const errors = [];

async function run(url) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(url + ' :: ' + m.text()); });
  page.on('pageerror', (e) => errors.push(url + ' :: PAGEERROR ' + e.message));
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));
  const info = await page.evaluate(() => {
    const scene = window.__game && window.__game.scene.getScene('Game');
    if (!scene || !scene.layout) return { ready: false };
    const p = scene.layout.portals || [];
    return {
      ready: true,
      mode: scene.layout.withTunnels === false ? 'portals' : 'tunnels',
      rooms: scene.layout.rooms.length,
      corridors: scene.layout.corridors.length,
      portals: p.length,
      portalViews: scene.portalViews ? scene.portalViews.size : -1,
      playerPos: scene.player ? { x: Math.round(scene.player.x), y: Math.round(scene.player.y) } : null,
      currentRoom: scene.currentRoom ? scene.currentRoom.id : null
    };
  });
  await browser.close();
  return info;
}

const A = await run(BASE + '/?seed=42');
const B = await run(BASE + '/?seed=42&tunnels=0');
const C = await run(BASE + '/?seed=42&tunnels=1');
console.log('default :', JSON.stringify(A));
console.log('portals :', JSON.stringify(B));
console.log('tunnels :', JSON.stringify(C));

const problems = [];
if (A.mode !== 'tunnels') problems.push('default not tunnels');
if (B.mode !== 'portals' || B.corridors !== 0 || B.portals !== A.rooms * 2 - 2) problems.push('portal mode layout wrong');
if (B.portalViews !== B.portals) problems.push(`portal views ${B.portalViews} != portals ${B.portals}`);
if (C.mode !== 'tunnels') problems.push('tunnels override wrong');

if (errors.length) { console.log('CONSOLE ERRORS:'); errors.slice(0, 12).forEach((e) => console.log('  ' + e)); problems.push('console errors'); }
console.log(problems.length ? 'SMOKE FAIL: ' + problems.join('; ') : 'SMOKE OK');
process.exit(problems.length ? 1 : 0);
