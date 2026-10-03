// Полный прогон игры: 20 игроков + ведущий + проектор + куратор, через настоящий интерфейс.
const { chromium } = require('playwright');
const BASE = 'http://localhost:8787/';
const API = 'http://localhost:8787/exec';
const URL = BASE + '?api=' + encodeURIComponent(API);
const SHOTS = process.env.SHOTS || '/tmp/claude-0/shots';
const N = Number(process.env.N || 20);
const fs = require('fs');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  async function page(viewport, url) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await p.goto(url);
    return p;
  }
  await fetch(API, { method: 'POST', body: JSON.stringify({ a: 'reset', pin: '2040' }) });
  const screen = await page({ width: 1600, height: 900 }, URL + '#screen');
  const host = await page({ width: 1280, height: 900 }, URL + '#host');
  await host.fill('[data-key="pin"]', '2040');
  await host.click('form[data-form="pin"] button');
  await host.waitForSelector('.hphases');

  const names = ['Аня Смирнова', 'Борис Ким', 'Вера Лис', 'Гоша Петров', 'Даша Орлова', 'Егор Павлов', 'Женя Ли', 'Зоя Мороз', 'Илья Гусев', 'Катя Белова', 'Лёша Ткач', 'Маша Ерёма', 'Никита Фом', 'Оля Зуева', 'Паша Рыжов', 'Рита Сом', 'Саша Юдин', 'Тима Волков', 'Уля Ноль', 'Фёдор Кот'];
  const players = [];
  for (let i = 0; i < N; i++) {
    const p = await page({ width: 390, height: 844 }, URL);
    await p.fill('[data-key="name"]', names[i]);
    await p.click('form[data-form="join"] button');
    players.push(p);
  }
  await Promise.all(players.map((p) => p.waitForSelector('.wait', { timeout: 15000 })));
  await sleep(2500);
  await players[0].screenshot({ path: SHOTS + '/01-player-wait.png' });
  await screen.screenshot({ path: SHOTS + '/02-screen-lobby.png' });
  await host.screenshot({ path: SHOTS + '/03-host-lobby.png', fullPage: true });

  // команды: половина выбирает сама, остальных раздаёт ведущий
  await host.click('button[data-act="phase"][data-phase="teams"]');
  await Promise.all(players.map((p) => p.waitForSelector('.teamgrid', { timeout: 15000 })));
  for (let i = 0; i < 10; i++) {
    await players[i].click(`.teamtile[data-team="${i % 5}"]`);
    await sleep(150);
  }
  await sleep(2500);
  await players[0].screenshot({ path: SHOTS + '/04-player-teams.png', fullPage: true });
  await host.click('button[data-act="autoTeams"][data-keep="1"]');
  await sleep(3000);
  await screen.screenshot({ path: SHOTS + '/05-screen-teams.png' });

  // миры
  await host.click('button[data-act="phase"][data-phase="world"]');
  await Promise.all(players.map((p) => p.waitForSelector('.wcard', { timeout: 15000 })));
  const teamOf = await Promise.all(players.map((p) => p.$eval('.bar .chip.team', (e) => e.textContent)));
  console.log('teams:', teamOf.join(''));
  const firstOf = {};
  teamOf.forEach((t, i) => { if (firstOf[t] == null) firstOf[t] = i; });
  const secondOf = {};
  teamOf.forEach((t, i) => { if (firstOf[t] !== i && secondOf[t] == null) secondOf[t] = i; });
  for (const t of Object.keys(firstOf)) {
    const p = players[firstOf[t]];
    await p.fill('[data-field="title"]', 'Мир команды ' + t);
    await p.fill('[data-field="residents"]', 'Жителям нужна работа и понятные перспективы, семьи думают об отъезде.');
    await p.fill('[data-field="business"]', 'Малый бизнес ищет новые рынки сбыта.');
    // одновременно второй участник пишет другое поле
    if (secondOf[t] != null) await players[secondOf[t]].fill('[data-field="government"]', 'Бюджет сокращается, нужно выбирать приоритеты.');
    await p.locator('[data-field="business"]').blur();
  }
  await sleep(4000);
  // проверка: у второго участника видно название, написанное первым
  for (const t of Object.keys(firstOf)) {
    if (secondOf[t] == null) continue;
    const v = await players[secondOf[t]].$eval('[data-field="title"]', (e) => e.value);
    const g = await players[firstOf[t]].$eval('[data-field="government"]', (e) => e.value);
    if (v !== 'Мир команды ' + t || !g) errors.push('sync fail team ' + t + ': ' + v + ' / ' + g);
  }
  await players[firstOf.A].screenshot({ path: SHOTS + '/06-player-world.png', fullPage: true });
  // перезагрузка страницы не должна выкидывать игрока из команды
  await players[firstOf.B].reload();
  await players[firstOf.B].waitForSelector('.wcard', { timeout: 15000 });
  const tAfter = await players[firstOf.B].$eval('.bar .chip.team', (e) => e.textContent);
  if (tAfter !== 'B') errors.push('reload lost team: ' + tAfter);
  const keepTitle = await players[firstOf.B].$eval('[data-field="title"]', (e) => e.value);
  if (keepTitle !== 'Мир команды B') errors.push('reload lost title');
  await screen.screenshot({ path: SHOTS + '/07-screen-matrix.png' });

  // карта: каждая команда ставит 5 проектов
  await host.click('button[data-act="phase"][data-phase="map"]');
  await Promise.all(players.map((p) => p.waitForSelector('.projects', { timeout: 15000 })));
  const plans = {
    A: [['p01', 'z2'], ['p06', 'z8'], ['p07', 'z7'], ['p09', 'z1'], ['p02', 'z3']],
    B: [['p01', 'z2'], ['p04', 'z2'], ['p09', 'z1'], ['p05', 'z3'], ['p14', 'z1']],
    C: [['p01', 'z2'], ['p07', 'z7'], ['p08', 'z5'], ['p15', 'z1'], ['p10', 'z6']],
    D: [['p03', 'z2'], ['p11', 'z5'], ['p12', 'z3'], ['p05', 'z3'], ['p02', 'z2']],
    E: [['p02', 'z3'], ['p01', 'z2'], ['p04', 'z2'], ['p06', 'z4'], ['p13', 'z8']],
  };
  for (const t of Object.keys(firstOf)) {
    const p = players[firstOf[t]];
    for (const [proj, zone] of plans[t]) {
      await p.click(`button[data-act="pick"][data-project="${proj}"]`);
      if (proj === plans[t][0][0]) { // первый — кликом по карте
        await p.click(`polygon[data-zone="${zone}"]`, { force: true });
      } else {
        await p.click(`.pickbar button[data-zone="${zone}"]`);
      }
      await p.waitForFunction((pr) => [...document.querySelectorAll('.placed b')].some((b) => b.textContent.length) && document.querySelectorAll('.proj.on').length > 0 && !document.querySelector('.pickbar'), proj, { timeout: 10000 });
      await sleep(300);
    }
    if (t === 'A') await p.screenshot({ path: SHOTS + '/08-player-map.png', fullPage: true });
    await p.fill('[data-field="rationale"]', 'Эти проекты дают работу и удерживают людей.');
    p.once('dialog', (d) => d.accept());
    await p.click('button[data-act="submitMap"]');
    await sleep(400);
  }
  await sleep(3000);
  const placedCount = await players[firstOf.C].$$eval('.placed li', (l) => l.length);
  if (placedCount !== 5) errors.push('team C placed ' + placedCount);
  await screen.screenshot({ path: SHOTS + '/09-screen-map.png' });

  await host.click('button[data-act="phase"][data-phase="overlay"]');
  await sleep(3000);
  await screen.screenshot({ path: SHOTS + '/10-screen-overlay.png' });
  await players[0].screenshot({ path: SHOTS + '/11-player-overlay.png', fullPage: true });

  // аукцион: 3 лота
  await host.click('button[data-act="phase"][data-phase="auction"]');
  await host.selectOption('select[data-act-change="lotSeconds"]', '20');
  const lots = ['p01', 'p07', 'p06', 'p11', 'p02'];
  for (const [li, lot] of lots.entries()) {
    await host.click(`button[data-act="startLot"][data-project="${lot}"]`);
    await Promise.all(players.map((p) => p.waitForSelector('.lot', { timeout: 15000 })));
    let k = 0;
    for (const t of Object.keys(firstOf)) {
      const p = players[firstOf[t]];
      const steps = (k + li * 2) % 5;
      for (let j = 0; j < steps; j++) await p.click('button[data-act="bidStep"][data-d="5"]');
      if (t === 'D') await p.click('button[data-act="pass"]');
      else await p.click('button[data-act="bid"]');
      k++;
      await sleep(200);
    }
    await sleep(2500);
    if (lot === 'p01') {
      await players[firstOf.B].screenshot({ path: SHOTS + '/12-player-auction.png', fullPage: true });
      await screen.screenshot({ path: SHOTS + '/13-screen-auction.png' });
      await host.screenshot({ path: SHOTS + '/14-host-auction.png', fullPage: true });
      // игрок другой команды не должен видеть сумму чужой ставки
      const pidA = await players[firstOf.A].evaluate(() => localStorage.getItem('f5:pid'));
      const view = await (await fetch(API + '?a=state&pid=' + pidA)).json();
      const others = view.state.teams.filter((t) => t.world !== 'A' && t.bid);
      if (others.some((t) => t.bid.amount != null)) errors.push('bid amounts leaked: ' + JSON.stringify(others.map((t) => t.bid)));
      const own = view.state.teams.find((t) => t.world === 'A');
      if (!own.bid || own.bid.amount == null) errors.push('own bid not visible');
    }
    await host.waitForFunction(() => !document.querySelector('.hlot'), null, { timeout: 40000 });
    await sleep(1500);
  }
  await screen.screenshot({ path: SHOTS + '/15-screen-auction-closed.png' });
  const stats = await (await fetch(API + '?a=state&pin=2040')).json();
  console.log('results:', JSON.stringify(stats.state.auction.results.map((r) => [r.project, r.team, r.price])));
  console.log('budgets:', stats.state.teams.map((t) => t.budget).join(','));
  const pub = await (await fetch(API + '?a=state')).json();
  if (pub.state.grades) errors.push('grades leaked to public');

  // судьба
  await host.click('button[data-act="phase"][data-phase="reveal"]');
  await sleep(1500);
  await host.click('button[data-act="spin"]');
  await sleep(2500);
  await screen.screenshot({ path: SHOTS + '/16-screen-wheel.png' });
  await sleep(6500);
  await screen.screenshot({ path: SHOTS + '/17-screen-reveal.png' });
  await players[firstOf.C].screenshot({ path: SHOTS + '/18-player-reveal.png', fullPage: true });

  await host.click('button[data-act="phase"][data-phase="shock"]');
  await sleep(800);
  await host.click('button[data-act="shock"][data-shock="s2"]');
  await sleep(3000);
  await screen.screenshot({ path: SHOTS + '/19-screen-shock.png' });
  await players[firstOf.E].screenshot({ path: SHOTS + '/20-player-shock.png', fullPage: true });

  await host.click('button[data-act="phase"][data-phase="results"]');
  await sleep(3000);
  await screen.screenshot({ path: SHOTS + '/21-screen-results.png' });
  await players[firstOf.A].screenshot({ path: SHOTS + '/22-player-results.png', fullPage: true });

  // куратор
  const cur = await page({ width: 430, height: 900 }, URL + '#curator');
  await cur.fill('[data-key="pin"]', '2040');
  await cur.click('form[data-form="pin"] button');
  await cur.waitForSelector('.tabs');
  await cur.fill('[data-key="curName"]', 'Егор');
  const nb = await cur.locator('button[data-act="grade"][data-k="c1"][data-v="3"]').count();
  for (let i = 0; i < nb; i++) { await cur.locator('button[data-act="grade"][data-k="c1"][data-v="3"]').nth(i).click(); await sleep(400); }
  for (let i = 0; i < nb; i++) { await cur.locator('button[data-act="grade"][data-k="c2"][data-v="2"]').nth(i).click(); await sleep(400); }
  await cur.locator('[data-note]').first().fill('Активно спорил на аукционе');
  await cur.locator('[data-note]').first().blur();
  await sleep(3000);
  await cur.screenshot({ path: SHOTS + '/23-curator.png', fullPage: true });

  await host.click('button[data-act="export"]');
  await sleep(2000);
  const sheet = await (await fetch(BASE + '__sheet?n=' + encodeURIComponent('Оценки'))).json();
  console.log('sheet rows:', sheet && sheet.length, JSON.stringify(sheet && sheet[1]));
  await host.screenshot({ path: SHOTS + '/24-host-results.png', fullPage: true });
  const st = await (await fetch(BASE + '__stats')).json();
  console.log('api calls:', st.calls);
  console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'NO ERRORS');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); console.log([...new Set(errors)].join('\n')); process.exit(1); });
