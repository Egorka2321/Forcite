/**
 * «Город в 5 мирах» — сервер игры на Google Apps Script.
 *
 * Как это работает: состояние игры хранится в CacheService (быстро, для опроса
 * раз в 1,5–2 с) и периодически копируется в лист «state» этой таблицы
 * (резерв на случай, если кэш очистится). Все изменения идут под LockService,
 * поэтому одновременные ставки и правки не теряются.
 *
 * Разверните как веб-приложение: «Выполнять от имени: Я», «Доступ: Все».
 */

// ======================= НАСТРОЙКИ =======================
var HOST_PIN = '2040';          // PIN ведущего и кураторов — ПОМЕНЯЙТЕ перед игрой
var START_BUDGET = 100;         // монет у каждой команды на аукционе
var MAP_LIMIT = 5;              // сколько проектов команда ставит на карту
var DEFAULT_TEAM_SIZE = 4;
// =========================================================

var WORLDS = ['A', 'B', 'C', 'D', 'E'];
var ZONES = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7', 'z8'];
var PHASES = ['lobby', 'teams', 'world', 'map', 'overlay', 'auction', 'reveal', 'shock', 'results'];
var TEXT_FIELDS = ['title', 'residents', 'business', 'government', 'rationale', 'shockAnswer'];

// Отдача проектов в каждом мире: [A, B, C, D, E]. Скрыта от игроков до раскрытия мира.
var PAYOFF = {
  p01: [3, 3, 4, 2, 2],    // Центр переобучения
  p02: [2, 2, 2, 2, 2],    // Энергоэффективное ЖКХ
  p03: [1, 2, 2, 3, 2],    // Компактный город
  p04: [1, 3, 2, 3, 2],    // Коворкинг и цифровые сервисы
  p05: [0, 2, 1, 3, 2],    // Мобильная медицина и соцтакси
  p06: [5, -2, 2, -3, 0],  // Новый жилой квартал
  p07: [4, 0, 5, -2, 1],   // Индустриальный парк
  p08: [3, -1, 5, -2, 0],  // Логистический хаб
  p09: [4, 3, -3, -3, 2],  // Инженерная школа комбината
  p10: [2, 0, 3, 1, 1],    // Туркластер «Озеро»
  p11: [-2, 1, 0, 5, 1],   // Программа «Мобильность»
  p12: [-2, 2, 0, 5, 1],   // Консервация пустующих домов
  p13: [3, -1, 1, -3, 0],  // Ледовая арена
  p14: [3, 2, -2, -1, 2],  // Агрокластер на тепле комбината
  p15: [-1, 0, 4, 1, 1]    // Креативный кластер в цехах
};
var PROJECTS = Object.keys(PAYOFF);

// Карты-шоки: поправки к отдаче проектов; zone/zoneMod — штраф проектам, стоящим в зоне.
var SHOCKS = {
  s1: { mods: { p07: 2, p01: 1, p15: 1, p08: 1 } },
  s2: { mods: { p02: 2, p06: -1, p10: -1 }, zone: 'z4', zoneMod: -2 },
  s3: { mods: { p04: 3, p06: 1, p03: 1, p11: -2 } },
  s4: { mods: { p09: -2, p14: -1, p07: -1, p01: 1 } },
  s5: { mods: { p06: -2, p13: -1, p05: 2, p03: 1 } }
};

// ---------------- HTTP ----------------
function doGet(e) { return respond_(route_((e && e.parameter) || {})); }

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  return respond_(route_(body));
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  try {
    var a = String(req.a || 'state');
    if (a === 'state') return readState_(req);
    if (a === 'ping') return { ok: true, now: Date.now() };
    return mutate_(function (s) { return act_(s, a, req); }, req);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), now: Date.now() };
  }
}

// ---------------- Хранение ----------------
var CACHE_TTL = 21600; // 6 часов — максимум CacheService
var CHUNK = 90000;

function cache_() { return CacheService.getScriptCache(); }

function loadState_() {
  var c = cache_();
  var n = c.get('state_n');
  if (n) {
    var keys = [];
    for (var i = 0; i < Number(n); i++) keys.push('state_' + i);
    var parts = c.getAll(keys);
    var str = '';
    var whole = true;
    for (var j = 0; j < keys.length; j++) {
      if (parts[keys[j]] == null) { whole = false; break; }
      str += parts[keys[j]];
    }
    if (whole && str) return JSON.parse(str);
  }
  // кэш пуст — берём резервную копию из листа
  var sh = sheet_('state');
  var vals = sh.getRange(1, 1, 1, 10).getValues()[0];
  var saved = vals.join('');
  if (saved) {
    var st = JSON.parse(saved);
    writeCache_(st);
    return st;
  }
  var fresh = newState_();
  writeCache_(fresh);
  return fresh;
}

function writeCache_(s) {
  var str = JSON.stringify(s);
  var obj = {};
  var n = Math.max(1, Math.ceil(str.length / CHUNK));
  for (var i = 0; i < n; i++) obj['state_' + i] = str.substr(i * CHUNK, CHUNK);
  obj['state_n'] = String(n);
  obj['ver'] = String(s.v);
  cache_().putAll(obj, CACHE_TTL);
}

function saveState_(s, force) {
  s.v = (s.v || 0) + 1;
  writeCache_(s);
  var c = cache_();
  var last = Number(c.get('savedAt') || 0);
  if (force || Date.now() - last > 4000) {
    var str = JSON.stringify(s);
    var row = [];
    for (var i = 0; i < 10; i++) row.push(str.substr(i * 45000, 45000));
    if (str.length > 450000) throw new Error('Состояние игры слишком большое');
    sheet_('state').getRange(1, 1, 1, 10).setValues([row]);
    c.put('savedAt', String(Date.now()), CACHE_TTL);
  }
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function newState_() {
  var teams = [];
  for (var i = 0; i < WORLDS.length; i++) {
    teams.push({
      id: i, world: WORLDS[i],
      title: '', residents: '', business: '', government: '', rationale: '', shockAnswer: '',
      edits: {},
      placements: {}, submitted: false, submittedBy: '',
      budget: START_BUDGET, bid: null
    });
  }
  return {
    v: 1, created: Date.now(), phase: 'lobby',
    teamMode: 'self', teamSize: DEFAULT_TEAM_SIZE,
    players: {}, order: [], teams: teams,
    auction: { current: null, results: [] },
    reveal: null, shock: null,
    grades: {}
  };
}

// ---------------- Чтение ----------------
function readState_(req) {
  var now = Date.now();
  var ver = cache_().get('ver');
  if (ver && req.v && String(req.v) === ver && !req.full) return { ok: true, same: true, v: Number(ver), now: now };
  var s = loadState_();
  return { ok: true, now: now, state: publicView_(s, req.pin === HOST_PIN, req.pid) };
}

function publicView_(s, isHost, pid) {
  var out = JSON.parse(JSON.stringify(s));
  if (!isHost) {
    delete out.grades;
    // во время торгов суммы чужих ставок не уходят на клиент — видно только «ставка сделана»
    var me = pid && s.players[pid];
    var myTeam = me ? me.team : null;
    out.teams.forEach(function (t) {
      if (t.bid) {
        var own = myTeam === t.id;
        t.bid = { made: true, pass: t.bid.amount === 0, by: own ? t.bid.by : '', amount: own ? t.bid.amount : null, at: t.bid.at };
      }
    });
  }
  out.isHost = !!isHost;
  if (s.reveal) {
    out.payoff = PAYOFF;
    out.score = score_(s);
  }
  if (s.shock) out.shockMods = SHOCKS[s.shock];
  return out;
}

// ---------------- Изменения ----------------
function mutate_(fn, req) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Сервер занят, повторите', now: Date.now() };
  try {
    var s = loadState_();
    var res = fn(s) || {};
    if (res.ok === false) return { ok: false, error: res.error, now: Date.now() };
    saveState_(s, !!res.force);
    res.ok = true;
    res.now = Date.now();
    res.state = publicView_(s, req.pin === HOST_PIN, req.pid);
    return res;
  } finally {
    lock.releaseLock();
  }
}

function fail_(msg) { return { ok: false, error: msg }; }

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max || 600);
}

function uid_() {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  var out = '';
  for (var i = 0; i < 8; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function playerTeam_(s, pid) {
  var p = s.players[pid];
  if (!p) return { error: 'Игрок не найден — войдите заново' };
  if (p.team == null) return { error: 'Вы пока не в команде' };
  return { p: p, t: s.teams[p.team] };
}

function act_(s, a, req) {
  var isHost = req.pin === HOST_PIN;
  var hostOnly = ['setPhase', 'setTeamMode', 'autoTeams', 'assign', 'kick', 'startLot', 'closeLot', 'cancelLot',
    'spin', 'setShock', 'reset', 'export', 'unlockMap', 'grade', 'rename', 'setBudget', 'undoLot'];
  if (hostOnly.indexOf(a) >= 0 && !isHost) return fail_('Неверный PIN');
  var now = Date.now();
  var r, t, p, i;

  switch (a) {
    case 'checkPin':
      return isHost ? {} : fail_('Неверный PIN');

    case 'join': {
      var name = clean_(req.name, 40).trim();
      if (!name) return fail_('Введите имя');
      if (req.pid && s.players[req.pid]) {
        s.players[req.pid].name = name;
        return { pid: req.pid };
      }
      var count = Object.keys(s.players).length;
      if (count >= 60) return fail_('Комната заполнена');
      var id = uid_();
      s.players[id] = { id: id, name: name, team: null, joined: now };
      s.order.push(id);
      return { pid: id };
    }

    case 'pickTeam': {
      p = s.players[req.pid];
      if (!p) return fail_('Игрок не найден — войдите заново');
      if (s.teamMode !== 'self') return fail_('Команды распределяет ведущий');
      if (s.phase !== 'teams' && s.phase !== 'lobby') return fail_('Выбор команд закрыт');
      var ti = req.team === null || req.team === '' ? null : Number(req.team);
      if (ti !== null) {
        if (!(ti >= 0 && ti < s.teams.length)) return fail_('Нет такой команды');
        var size = teamSize_(s, ti);
        if (p.team !== ti && size >= s.teamSize) return fail_('В этой команде уже нет мест');
      }
      p.team = ti;
      return {};
    }

    case 'field': {
      r = playerTeam_(s, req.pid); if (r.error) return fail_(r.error);
      if (TEXT_FIELDS.indexOf(req.field) < 0) return fail_('Нет такого поля');
      r.t[req.field] = clean_(req.value, req.field === 'title' ? 60 : 600);
      r.t.edits[req.field] = { by: r.p.name, at: now };
      return {};
    }

    case 'place': {
      r = playerTeam_(s, req.pid); if (r.error) return fail_(r.error);
      if (s.phase !== 'map') return fail_('Сейчас не этап карты');
      if (r.t.submitted) return fail_('План уже отправлен');
      if (PROJECTS.indexOf(req.project) < 0) return fail_('Нет такого проекта');
      if (req.zone == null || req.zone === '') {
        delete r.t.placements[req.project];
      } else {
        if (ZONES.indexOf(req.zone) < 0) return fail_('Нет такой зоны');
        if (!r.t.placements[req.project] && Object.keys(r.t.placements).length >= MAP_LIMIT)
          return fail_('Можно выбрать не больше ' + MAP_LIMIT + ' проектов');
        r.t.placements[req.project] = req.zone;
      }
      r.t.edits.map = { by: r.p.name, at: now };
      return {};
    }

    case 'submitMap': {
      r = playerTeam_(s, req.pid); if (r.error) return fail_(r.error);
      if (Object.keys(r.t.placements).length < 1) return fail_('Поставьте на карту хотя бы один проект');
      r.t.submitted = true;
      r.t.submittedBy = r.p.name;
      return {};
    }

    case 'bid': {
      r = playerTeam_(s, req.pid); if (r.error) return fail_(r.error);
      var cur = s.auction.current;
      if (s.phase !== 'auction' || !cur) return fail_('Лот сейчас не открыт');
      if (now > cur.endsAt + 1500) return fail_('Время на ставку вышло');
      var amount = Math.floor(Number(req.amount));
      if (!(amount >= 0)) return fail_('Неверная сумма');
      if (amount > r.t.budget) return fail_('Не хватает монет: в бюджете ' + r.t.budget);
      if (amount > 0 && amount < 5) return fail_('Минимальная ставка — 5 монет');
      r.t.bid = { amount: amount, by: r.p.name, at: now };
      return {};
    }

    // ----- ведущий -----
    case 'setPhase': {
      if (PHASES.indexOf(req.phase) < 0) return fail_('Нет такого этапа');
      s.phase = req.phase;
      if (req.phase === 'reveal' && !s.reveal) { /* мир выбирается кнопкой «Крутить» */ }
      return { force: true };
    }

    case 'setTeamMode': {
      if (req.mode) s.teamMode = req.mode === 'host' ? 'host' : 'self';
      if (req.size) s.teamSize = Math.max(1, Math.min(10, Number(req.size)));
      return {};
    }

    case 'autoTeams': {
      var ids = s.order.filter(function (id) { return s.players[id]; });
      if (!req.keep) ids.forEach(function (id) { s.players[id].team = null; });
      var free = ids.filter(function (id) { return s.players[id].team == null; });
      // перемешиваем и раздаём в самые маленькие команды
      for (i = free.length - 1; i > 0; i--) {
        var k = Math.floor(Math.random() * (i + 1));
        var tmp = free[i]; free[i] = free[k]; free[k] = tmp;
      }
      free.forEach(function (id) {
        var best = 0;
        for (var tj = 1; tj < s.teams.length; tj++) if (teamSize_(s, tj) < teamSize_(s, best)) best = tj;
        s.players[id].team = best;
      });
      return { force: true };
    }

    case 'assign': {
      p = s.players[req.pid];
      if (!p) return fail_('Игрок не найден');
      p.team = req.team === null || req.team === '' ? null : Number(req.team);
      return {};
    }

    case 'rename': {
      p = s.players[req.pid];
      if (!p) return fail_('Игрок не найден');
      p.name = clean_(req.name, 40) || p.name;
      return {};
    }

    case 'kick': {
      if (!s.players[req.pid]) return fail_('Игрок не найден');
      delete s.players[req.pid];
      s.order = s.order.filter(function (id) { return id !== req.pid; });
      return {};
    }

    case 'unlockMap': {
      t = s.teams[Number(req.team)];
      if (!t) return fail_('Нет такой команды');
      t.submitted = false;
      return {};
    }

    case 'setBudget': {
      t = s.teams[Number(req.team)];
      if (!t) return fail_('Нет такой команды');
      t.budget = Math.max(0, Math.floor(Number(req.budget) || 0));
      return {};
    }

    case 'startLot': {
      if (s.auction.current) return fail_('Сначала закройте текущий лот');
      if (PROJECTS.indexOf(req.project) < 0) return fail_('Нет такого проекта');
      if (s.auction.results.some(function (x) { return x.project === req.project; })) return fail_('Этот лот уже разыгран');
      var sec = Math.max(10, Math.min(180, Number(req.seconds) || 40));
      s.auction.current = { project: req.project, startedAt: now, endsAt: now + sec * 1000, seconds: sec };
      s.teams.forEach(function (tt) { tt.bid = null; });
      s.phase = 'auction';
      return { force: true };
    }

    case 'cancelLot': {
      s.auction.current = null;
      s.teams.forEach(function (tt) { tt.bid = null; });
      return {};
    }

    case 'closeLot': {
      var c2 = s.auction.current;
      if (!c2) return {};
      if (req.project && req.project !== c2.project) return {}; // запоздалый запрос по уже закрытому лоту
      var winner = null;
      var bids = {};
      s.teams.forEach(function (tt) {
        if (tt.bid) bids[tt.id] = tt.bid.amount;
        if (tt.bid && tt.bid.amount > 0) {
          if (!winner || tt.bid.amount > winner.bid.amount ||
            (tt.bid.amount === winner.bid.amount && tt.bid.at < winner.bid.at)) winner = tt;
        }
      });
      var res = { project: c2.project, team: winner ? winner.id : null, price: winner ? winner.bid.amount : 0, bids: bids, at: now };
      if (winner) winner.budget -= winner.bid.amount;
      s.auction.results.push(res);
      s.auction.current = null;
      s.teams.forEach(function (tt) { tt.bid = null; });
      return { force: true, result: res };
    }

    case 'undoLot': {
      var last = s.auction.results.pop();
      if (last && last.team != null) s.teams[last.team].budget += last.price;
      return {};
    }

    case 'spin': {
      var w = req.world && WORLDS.indexOf(req.world) >= 0 ? req.world : WORLDS[Math.floor(Math.random() * WORLDS.length)];
      s.reveal = { world: w, at: now, spinId: uid_() };
      s.phase = 'reveal';
      return { force: true };
    }

    case 'setShock': {
      if (req.shock && !SHOCKS[req.shock]) return fail_('Нет такой карты');
      s.shock = req.shock || null;
      s.shockAt = now;
      if (s.shock) s.phase = 'shock';
      return { force: true };
    }

    case 'grade': {
      if (!s.players[req.pid]) return fail_('Игрок не найден');
      var g = s.grades[req.pid] || {};
      ['c1', 'c2', 'c3', 'c4'].forEach(function (k) {
        if (req[k] !== undefined && req[k] !== null && req[k] !== '') g[k] = Number(req[k]);
      });
      if (req.note !== undefined) g.note = clean_(req.note, 300);
      if (req.by) g.by = clean_(req.by, 40);
      g.at = now;
      s.grades[req.pid] = g;
      return {};
    }

    case 'export': {
      exportSheets_(s);
      return { force: true };
    }

    case 'reset': {
      var keepPlayers = !!req.keepPlayers;
      var old = s;
      var fresh = newState_();
      if (keepPlayers) {
        fresh.players = old.players;
        fresh.order = old.order;
        Object.keys(fresh.players).forEach(function (id) { fresh.players[id].team = null; });
      }
      Object.keys(s).forEach(function (k) { delete s[k]; });
      Object.keys(fresh).forEach(function (k) { s[k] = fresh[k]; });
      s.v = (old.v || 0) + 1;
      return { force: true };
    }
  }
  return fail_('Неизвестное действие: ' + a);
}

function teamSize_(s, ti) {
  var n = 0;
  Object.keys(s.players).forEach(function (id) { if (s.players[id].team === ti) n++; });
  return n;
}

// ---------------- Подсчёт очков ----------------
function projectZone_(s, project, teamId) {
  var t = s.teams[teamId];
  if (t && t.placements[project]) return t.placements[project];
  var counts = {};
  s.teams.forEach(function (tt) {
    var z = tt.placements[project];
    if (z) counts[z] = (counts[z] || 0) + 1;
  });
  var best = null;
  Object.keys(counts).forEach(function (z) { if (!best || counts[z] > counts[best]) best = z; });
  return best;
}

function value_(s, project, worldIdx, teamId, withShock) {
  var v = PAYOFF[project][worldIdx];
  if (withShock && s.shock) {
    var sh = SHOCKS[s.shock];
    if (sh.mods[project]) v += sh.mods[project];
    if (sh.zone && projectZone_(s, project, teamId) === sh.zone) v += sh.zoneMod;
  }
  return v;
}

function score_(s) {
  var wIdx = WORLDS.indexOf(s.reveal.world);
  var teams = s.teams.map(function (t) {
    var won = s.auction.results.filter(function (x) { return x.team === t.id; });
    var byWorld = WORLDS.map(function (w, wi) {
      return won.reduce(function (acc, x) { return acc + value_(s, x.project, wi, t.id, false); }, 0);
    });
    var actual = won.reduce(function (acc, x) { return acc + value_(s, x.project, wIdx, t.id, true); }, 0);
    var min = byWorld.length ? Math.min.apply(null, byWorld) : 0;
    var avg = byWorld.reduce(function (a2, b) { return a2 + b; }, 0) / WORLDS.length;
    return {
      team: t.id, projects: won.map(function (x) { return { project: x.project, price: x.price, zone: projectZone_(s, x.project, t.id), value: value_(s, x.project, wIdx, t.id, true) }; }),
      byWorld: byWorld, base: byWorld[wIdx], actual: actual, min: min, avg: Math.round(avg * 10) / 10, left: t.budget
    };
  });
  var city = teams.reduce(function (acc, x) { return acc + x.actual; }, 0);
  return { world: s.reveal.world, teams: teams, city: city };
}

// ---------------- Выгрузка в таблицу ----------------
function exportSheets_(s) {
  var sh = sheet_('Оценки');
  sh.clear();
  var rows = [['Игрок', 'Команда', 'Вовлечённость (0–3)', 'Анализ мира (0–3)', 'Обоснованность решений (0–2)', 'Рефлексия (0–2)', 'Итог (0–10)', 'Комментарий', 'Куратор']];
  s.order.forEach(function (id) {
    var p = s.players[id];
    if (!p) return;
    var g = s.grades[id] || {};
    var total = ['c1', 'c2', 'c3', 'c4'].reduce(function (a, k) { return a + (Number(g[k]) || 0); }, 0);
    rows.push([p.name, p.team == null ? '—' : WORLDS[p.team], g.c1 == null ? '' : g.c1, g.c2 == null ? '' : g.c2,
      g.c3 == null ? '' : g.c3, g.c4 == null ? '' : g.c4, total, g.note || '', g.by || '']);
  });
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);

  var sh2 = sheet_('Итоги');
  sh2.clear();
  var rows2 = [['Команда', 'Название мира', 'Жители', 'Бизнес', 'Власть', 'Обоснование плана', 'Проекты на карте', 'Купленные проекты', 'Очки в наступившем мире', 'Минимум по мирам', 'Ответ на шок']];
  var sc = s.reveal ? score_(s) : null;
  s.teams.forEach(function (t) {
    var won = s.auction.results.filter(function (x) { return x.team === t.id; }).map(function (x) { return x.project + ' (' + x.price + ')'; }).join(', ');
    var st = sc ? sc.teams[t.id] : null;
    rows2.push([t.world, t.title, t.residents, t.business, t.government, t.rationale,
      Object.keys(t.placements).map(function (k) { return k + '→' + t.placements[k]; }).join(', '),
      won, st ? st.actual : '', st ? st.min : '', t.shockAnswer]);
  });
  sh2.getRange(1, 1, rows2.length, rows2[0].length).setValues(rows2);
}

// Запустите один раз вручную из редактора, чтобы выдать скрипту доступ к таблице.
function setup() {
  sheet_('state');
  Logger.log('Готово. Теперь: Развернуть → Новое развертывание → Веб-приложение.');
}
