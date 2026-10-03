// Локальная эмуляция Google Apps Script: запускает НАСТОЯЩИЙ gas/Code.gs в Node
// с подменёнными CacheService / LockService / SpreadsheetApp / ContentService.
// Раздаёт сайт из ../docs и API по адресу /exec. Только для тестов.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = Number(process.env.PORT || 8787);
const LATENCY = Number(process.env.LATENCY || 250);
const SITE = path.join(__dirname, '..', 'docs');

// ---- моки Google ----
const cacheStore = new Map();
const CacheService = {
  getScriptCache() {
    return {
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
      getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cacheStore.has(k)) o[k] = cacheStore.get(k); }); return o; },
      put: (k, v) => { if (String(v).length > 100000) throw new Error('cache value too big'); cacheStore.set(k, String(v)); },
      putAll: (obj) => { Object.keys(obj).forEach((k) => { if (String(obj[k]).length > 100000) throw new Error('cache value too big'); cacheStore.set(k, String(obj[k])); }); },
    };
  },
};
let locked = false;
const LockService = {
  getScriptLock() {
    return { tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; } };
  },
};
const sheets = {};
function makeSheet(name) {
  const data = [];
  return {
    name,
    getRange(r, c, nr, nc) {
      return {
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
        setValues(vals) { vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => { if (String(v).length > 50000) throw new Error('cell > 50000'); data[r - 1 + i][c - 1 + j] = v; }); }); },
      };
    },
    clear() { data.length = 0; },
    _data: data,
  };
}
const SpreadsheetApp = {
  getActiveSpreadsheet() {
    return {
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => (sheets[n] = makeSheet(n)),
    };
  },
};
const ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput(text) { return { text, setMimeType() { return this; } }; },
};
const ctx = vm.createContext({ CacheService, LockService, SpreadsheetApp, ContentService, Logger: { log: console.log }, console, Date, Math, JSON });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

let calls = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/exec') {
    calls++;
    const finish = (out) => setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out.text);
    }, LATENCY * (0.5 + Math.random()));
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => finish(ctx.doPost({ postData: { contents: body } })));
    } else {
      finish(ctx.doGet({ parameter: Object.fromEntries(url.searchParams) }));
    }
    return;
  }
  if (url.pathname === '/__stats') { res.end(JSON.stringify({ calls, sheets: Object.keys(sheets) })); return; }
  if (url.pathname === '/__sheet') {
    const sh = sheets[url.searchParams.get('n')];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(sh ? sh._data : null));
    return;
  }
  let p = path.join(SITE, decodeURIComponent(url.pathname));
  if (p.endsWith('/')) p += 'index.html';
  if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
server.listen(PORT, () => console.log('mock on http://localhost:' + PORT));
