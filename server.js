// Захват территорий — игровой сервер (HTTP + WebSocket)
// Запуск: node server.js   (PORT=3000 по умолчанию, DEV=1 включает тестовый «ручной GPS»)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const h3 = require('h3-js');

// ───────────────────────── Настройки игры ─────────────────────────
const CFG = {
  PORT: Number(process.env.PORT) || 3000,
  DEV: process.env.DEV === '1',          // разрешить ручную установку позиции (для тестов на ПК)
  RES: 9,                                // размер гекса H3: res 9 ≈ 0.1 км², ребро ≈ 175 м
  REGION_RES: 6,                         // «регионы» для подписки на обновления (≈36 км²)
  CAPTURE_RING: 1,                       // захват: свой гекс + соседи на расстоянии 1
  MAX_ACCURACY_M: 150,                   // GPS хуже этого — захват запрещён
  POS_MAX_AGE_MS: 60_000,                // позиция должна быть свежей
  MAX_SPEED_KMH: 300,                    // быстрее — «телепорт», блок на минуту
  TELEPORT_LOCK_MS: 60_000,
  MAX_HP: 5,                             // максимальная прочность гекса
  ENERGY_MAX: 20,
  ENERGY_REGEN_MS: 30_000,               // +1 энергия каждые 30 сек
  ACTION_COOLDOWN_MS: 1_500,
  REINFORCE_COST: 5,                     // монет за +1 прочности своему гексу
  INCOME_PER_CELL_MIN: 0.1,              // монет в минуту за каждый гекс (6 в час)
  CLAN_SHARE: 0.2,                       // доля дохода, идущая дополнительно в казну клана
  CAPTURE_BONUS: 2,                      // монет за захват
  START_COINS: 10,
};

const FACTIONS = {
  1: { id: 1, name: 'Фракция 1' },
  2: { id: 2, name: 'Фракция 2' },
};

// ───────────────────────── Хранилище ─────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
let S = { players: {}, clans: {}, cells: {} };
// players[id] = {id, token, name, faction, clan, coins, energy, energyTs, pos, lockUntil, captured, created}
// clans[id]   = {id, name, tag, faction, leader, members:[ids], treasury, created}
// cells[h3]   = {f: faction, p: playerId, c: clanId|null, hp, ts}
const tokenIndex = new Map();     // token -> playerId
const regionCells = new Map();    // regionH3 -> Set(cellH3)
let dirty = false;

function load() {
  try {
    S = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    S.players ||= {}; S.clans ||= {}; S.cells ||= {};
  } catch { /* первый запуск */ }
  for (const p of Object.values(S.players)) tokenIndex.set(p.token, p.id);
  for (const id of Object.keys(S.cells)) indexCell(id);
  console.log(`Загружено: игроков ${Object.keys(S.players).length}, кланов ${Object.keys(S.clans).length}, гексов ${Object.keys(S.cells).length}`);
}
function save() {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, DATA_FILE);
  dirty = false;
}
function indexCell(id) {
  const r = h3.cellToParent(id, CFG.REGION_RES);
  if (!regionCells.has(r)) regionCells.set(r, new Set());
  regionCells.get(r).add(id);
}

// ───────────────────────── Утилиты ─────────────────────────
const now = () => Date.now();
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function regenEnergy(p) {
  const t = now();
  if (p.energy >= CFG.ENERGY_MAX) { p.energyTs = t; return; }
  const gained = Math.floor((t - p.energyTs) / CFG.ENERGY_REGEN_MS);
  if (gained > 0) {
    p.energy = Math.min(CFG.ENERGY_MAX, p.energy + gained);
    p.energyTs = p.energy >= CFG.ENERGY_MAX ? t : p.energyTs + gained * CFG.ENERGY_REGEN_MS;
  }
}

function publicPlayer(p) {
  regenEnergy(p);
  const clan = p.clan ? S.clans[p.clan] : null;
  return {
    id: p.id, name: p.name, faction: p.faction,
    clan: clan ? { id: clan.id, name: clan.name, tag: clan.tag, leader: clan.leader === p.id, treasury: Math.floor(clan.treasury), members: clan.members.length } : null,
    coins: Math.floor(p.coins), energy: p.energy, energyMax: CFG.ENERGY_MAX,
    nextEnergyIn: p.energy >= CFG.ENERGY_MAX ? 0 : CFG.ENERGY_REGEN_MS - (now() - p.energyTs),
    cells: countPlayerCells(p.id), captured: p.captured || 0,
    lockUntil: p.lockUntil || 0,
  };
}
const playerCellCount = new Map();
function countPlayerCells(id) { return playerCellCount.get(id) || 0; }
function recountPlayers() {
  playerCellCount.clear();
  for (const c of Object.values(S.cells)) playerCellCount.set(c.p, (playerCellCount.get(c.p) || 0) + 1);
}

function cellView(id) {
  const c = S.cells[id];
  if (!c) return { id, f: 0 };
  const owner = S.players[c.p];
  const clan = c.c ? S.clans[c.c] : null;
  return { id, f: c.f, hp: c.hp, owner: owner ? owner.name : '?', clan: clan ? clan.tag : null, ts: c.ts };
}

// ───────────────────────── Подключения ─────────────────────────
const clients = new Set(); // ws: {player, regions:Set}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendMe(p) { for (const ws of clients) if (ws.player === p) send(ws, { t: 'me', me: publicPlayer(p) }); }
function toastPlayer(pid, text, kind = 'info') {
  for (const ws of clients) if (ws.player && ws.player.id === pid) send(ws, { t: 'toast', text, kind });
}
let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; const st = computeStats(); for (const ws of clients) if (ws.player) send(ws, { t: 'stats', stats: st }); }, 1000);
}
function broadcastCell(id) {
  const r = h3.cellToParent(id, CFG.REGION_RES);
  const msg = JSON.stringify({ t: 'cell', cell: cellView(id) });
  for (const ws of clients) if (ws.regions.has(r) && ws.readyState === 1) ws.send(msg);
}

// ───────────────────────── Игровые действия ─────────────────────────
function register(ws, { name, faction }) {
  name = clean(name, 20);
  faction = Number(faction);
  if (name.length < 2) return send(ws, { t: 'err', text: 'Имя должно быть от 2 до 20 символов' });
  if (!FACTIONS[faction]) return send(ws, { t: 'err', text: 'Выберите фракцию' });
  const p = {
    id: uid(6), token: uid(16), name, faction, clan: null,
    coins: CFG.START_COINS, energy: CFG.ENERGY_MAX, energyTs: now(),
    pos: null, lockUntil: 0, captured: 0, created: now(),
  };
  S.players[p.id] = p; tokenIndex.set(p.token, p.id); dirty = true;
  ws.player = p;
  send(ws, { t: 'registered', token: p.token, me: publicPlayer(p) });
}

function listClans(ws) {
  const p = ws.player; if (!p) return;
  const list = Object.values(S.clans)
    .filter(c => c.faction === p.faction)
    .map(c => ({ id: c.id, name: c.name, tag: c.tag, members: c.members.length, cells: clanCellCount(c.id) }))
    .sort((a, b) => b.cells - a.cells || b.members - a.members)
    .slice(0, 100);
  send(ws, { t: 'clans', list });
}
function clanCellCount(cid) { let n = 0; for (const c of Object.values(S.cells)) if (c.c === cid) n++; return n; }

function clanCreate(ws, { name, tag }) {
  const p = ws.player; if (!p) return;
  if (p.clan) return send(ws, { t: 'err', text: 'Сначала выйдите из текущего клана' });
  name = clean(name, 24); tag = clean(tag, 5).toUpperCase();
  if (name.length < 3) return send(ws, { t: 'err', text: 'Название клана — от 3 символов' });
  if (tag.length < 2) return send(ws, { t: 'err', text: 'Тег клана — от 2 до 5 символов' });
  if (Object.values(S.clans).some(c => c.tag === tag)) return send(ws, { t: 'err', text: `Тег [${tag}] уже занят` });
  const c = { id: uid(5), name, tag, faction: p.faction, leader: p.id, members: [p.id], treasury: 0, created: now() };
  S.clans[c.id] = c; p.clan = c.id; dirty = true;
  send(ws, { t: 'toast', text: `Клан [${tag}] ${name} создан`, kind: 'ok' });
  sendMe(p);
}
function clanJoin(ws, { id }) {
  const p = ws.player; if (!p) return;
  const c = S.clans[id];
  if (!c) return send(ws, { t: 'err', text: 'Клан не найден' });
  if (c.faction !== p.faction) return send(ws, { t: 'err', text: 'Этот клан из другой фракции' });
  if (p.clan) return send(ws, { t: 'err', text: 'Сначала выйдите из текущего клана' });
  c.members.push(p.id); p.clan = c.id; dirty = true;
  for (const m of c.members) if (m !== p.id) toastPlayer(m, `${p.name} вступил в клан`, 'info');
  send(ws, { t: 'toast', text: `Вы вступили в [${c.tag}] ${c.name}`, kind: 'ok' });
  sendMe(p);
}
function clanLeave(ws) {
  const p = ws.player; if (!p || !p.clan) return;
  const c = S.clans[p.clan];
  p.clan = null; dirty = true;
  if (c) {
    c.members = c.members.filter(m => m !== p.id);
    if (c.members.length === 0) {
      delete S.clans[c.id];
      for (const cell of Object.values(S.cells)) if (cell.c === c.id) cell.c = null;
    } else if (c.leader === p.id) c.leader = c.members[0];
  }
  send(ws, { t: 'toast', text: 'Вы вышли из клана', kind: 'info' });
  sendMe(p);
}

function updatePos(ws, { lat, lng, acc, manual }) {
  const p = ws.player; if (!p) return;
  lat = Number(lat); lng = Number(lng); acc = Number(acc) || 9999;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  if (manual) { if (!CFG.DEV) return send(ws, { t: 'err', text: 'Ручная позиция отключена на этом сервере' }); acc = 5; }
  const t = now();
  if (p.pos && !manual) {
    const dt = (t - p.pos.t) / 1000;
    const d = haversineM(p.pos, { lat, lng });
    if (dt > 0 && d > 500 && (d / dt) * 3.6 > CFG.MAX_SPEED_KMH) {
      p.lockUntil = t + CFG.TELEPORT_LOCK_MS;
      send(ws, { t: 'toast', text: 'Слишком резкое перемещение — захват заблокирован на минуту', kind: 'warn' });
    }
  }
  p.pos = { lat, lng, acc, t };
  dirty = true;
}

function act(ws, { cell }) {
  const p = ws.player; if (!p) return;
  const t = now();
  if (!h3.isValidCell(cell) || h3.getResolution(cell) !== CFG.RES) return send(ws, { t: 'err', text: 'Неверный гекс' });
  if (ws.lastAct && t - ws.lastAct < CFG.ACTION_COOLDOWN_MS) return send(ws, { t: 'err', text: 'Не так быстро' });
  if (!p.pos || t - p.pos.t > CFG.POS_MAX_AGE_MS) return send(ws, { t: 'err', text: 'Нет свежих GPS-данных. Включите геолокацию' });
  if (p.pos.acc > CFG.MAX_ACCURACY_M) return send(ws, { t: 'err', text: `Слабый сигнал GPS (±${Math.round(p.pos.acc)} м). Нужно точнее ${CFG.MAX_ACCURACY_M} м` });
  if (p.lockUntil > t) return send(ws, { t: 'err', text: `Захват заблокирован ещё ${Math.ceil((p.lockUntil - t) / 1000)} с` });
  const here = h3.latLngToCell(p.pos.lat, p.pos.lng, CFG.RES);
  let dist;
  try { dist = h3.gridDistance(here, cell); } catch { dist = 99; }
  if (dist > CFG.CAPTURE_RING) return send(ws, { t: 'err', text: 'Слишком далеко. Подойдите ближе к этому гексу' });

  regenEnergy(p);
  const c = S.cells[cell];
  ws.lastAct = t;

  if (c && c.f === p.faction) {
    // Укрепление своего гекса за монеты
    if (c.hp >= CFG.MAX_HP) return send(ws, { t: 'err', text: 'Гекс уже укреплён до максимума' });
    if (p.coins < CFG.REINFORCE_COST) return send(ws, { t: 'err', text: `Нужно ${CFG.REINFORCE_COST} монет для укрепления` });
    p.coins -= CFG.REINFORCE_COST; c.hp += 1; c.ts = t;
    send(ws, { t: 'toast', text: `Укреплено: прочность ${c.hp}/${CFG.MAX_HP}`, kind: 'ok' });
  } else {
    if (p.energy < 1) return send(ws, { t: 'err', text: 'Нет энергии. Она восстанавливается: +1 каждые 30 с' });
    if (p.energy >= CFG.ENERGY_MAX) p.energyTs = t;
    p.energy -= 1;
    if (!c) {
      S.cells[cell] = { f: p.faction, p: p.id, c: p.clan, hp: 1, ts: t };
      indexCell(cell);
      playerCellCount.set(p.id, countPlayerCells(p.id) + 1);
      p.captured = (p.captured || 0) + 1; p.coins += CFG.CAPTURE_BONUS;
      send(ws, { t: 'toast', text: `Гекс захвачен! +${CFG.CAPTURE_BONUS} монеты`, kind: 'ok', fx: cell });
    } else {
      c.hp -= 1; c.ts = t;
      if (c.hp <= 0) {
        const prev = c.p;
        playerCellCount.set(prev, Math.max(0, countPlayerCells(prev) - 1));
        playerCellCount.set(p.id, countPlayerCells(p.id) + 1);
        S.cells[cell] = { f: p.faction, p: p.id, c: p.clan, hp: 1, ts: t };
        p.captured = (p.captured || 0) + 1; p.coins += CFG.CAPTURE_BONUS;
        send(ws, { t: 'toast', text: `Вражеский гекс отбит! +${CFG.CAPTURE_BONUS} монеты`, kind: 'ok', fx: cell });
        toastPlayer(prev, `${p.name} (${FACTIONS[p.faction].name}) захватил ваш гекс`, 'warn');
        const prevP = S.players[prev]; if (prevP) sendMe(prevP);
      } else {
        send(ws, { t: 'toast', text: `Атака! Прочность врага: ${c.hp}/${CFG.MAX_HP}`, kind: 'info' });
        toastPlayer(c.p, `Ваш гекс атакуют! Осталось ${c.hp}/${CFG.MAX_HP}`, 'warn');
      }
    }
  }
  dirty = true;
  broadcastCell(cell);
  scheduleStats();
  sendMe(p);
}

function setView(ws, { regions }) {
  if (!Array.isArray(regions)) return;
  const next = new Set(regions.filter(r => typeof r === 'string' && h3.isValidCell(r) && h3.getResolution(r) === CFG.REGION_RES).slice(0, 80));
  const added = [...next].filter(r => !ws.regions.has(r));
  ws.regions = next;
  const cells = [];
  for (const r of added) for (const id of regionCells.get(r) || []) cells.push(cellView(id));
  send(ws, { t: 'cells', cells });
}

// ───────────────────────── Статистика и доход ─────────────────────────
let statsCache = null;
function computeStats() {
  const f = { 1: 0, 2: 0 };
  const clanCells = new Map();
  for (const c of Object.values(S.cells)) {
    f[c.f] = (f[c.f] || 0) + 1;
    if (c.c) clanCells.set(c.c, (clanCells.get(c.c) || 0) + 1);
  }
  const players = { 1: 0, 2: 0 };
  for (const p of Object.values(S.players)) players[p.faction]++;
  const topClans = [...clanCells.entries()]
    .map(([id, n]) => ({ id, n, c: S.clans[id] })).filter(x => x.c)
    .sort((a, b) => b.n - a.n).slice(0, 10)
    .map(x => ({ name: x.c.name, tag: x.c.tag, faction: x.c.faction, cells: x.n, members: x.c.members.length }));
  const topPlayers = [...playerCellCount.entries()]
    .map(([id, n]) => ({ p: S.players[id], n })).filter(x => x.p && x.n > 0)
    .sort((a, b) => b.n - a.n).slice(0, 10)
    .map(x => ({ name: x.p.name, faction: x.p.faction, cells: x.n, clan: x.p.clan && S.clans[x.p.clan] ? S.clans[x.p.clan].tag : null }));
  let online = 0; for (const ws of clients) if (ws.player) online++;
  statsCache = { factions: [1, 2].map(i => ({ id: i, name: FACTIONS[i].name, cells: f[i] || 0, players: players[i] })), topClans, topPlayers, online };
  return statsCache;
}

function incomeTick() {
  // раз в минуту: каждый гекс приносит монеты владельцу, часть — в казну клана
  for (const c of Object.values(S.cells)) {
    const p = S.players[c.p];
    if (p) p.coins += CFG.INCOME_PER_CELL_MIN;
    if (c.c && S.clans[c.c]) S.clans[c.c].treasury += CFG.INCOME_PER_CELL_MIN * CFG.CLAN_SHARE;
  }
  if (Object.keys(S.cells).length) dirty = true;
  for (const ws of clients) if (ws.player) send(ws, { t: 'me', me: publicPlayer(ws.player) });
}

// ───────────────────────── HTTP ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const STATIC = {
  '/vendor/leaflet.js': path.join(__dirname, 'node_modules/leaflet/dist/leaflet.js'),
  '/vendor/leaflet.css': path.join(__dirname, 'node_modules/leaflet/dist/leaflet.css'),
  '/vendor/h3.js': path.join(__dirname, 'node_modules/h3-js/dist/h3-js.umd.js'),
};
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ res: CFG.RES, regionRes: CFG.REGION_RES, ring: CFG.CAPTURE_RING, maxHp: CFG.MAX_HP, reinforceCost: CFG.REINFORCE_COST, dev: CFG.DEV, factions: Object.values(FACTIONS), incomePerHour: CFG.INCOME_PER_CELL_MIN * 60, maxAcc: CFG.MAX_ACCURACY_M }));
  }
  if (p === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(statsCache || computeStats()));
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let file = STATIC[p];
  if (!file) {
    if (p === '/') p = '/index.html';
    file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.player = null; ws.regions = new Set(); ws.alive = true;
  clients.add(ws);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.t) {
        case 'hello': {
          const id = tokenIndex.get(m.token);
          if (id && S.players[id]) { ws.player = S.players[id]; send(ws, { t: 'me', me: publicPlayer(ws.player) }); }
          else send(ws, { t: 'need_register' });
          break;
        }
        case 'register': if (!ws.player) register(ws, m); break;
        case 'clans': listClans(ws); break;
        case 'clan_create': clanCreate(ws, m); break;
        case 'clan_join': clanJoin(ws, m); break;
        case 'clan_leave': clanLeave(ws); break;
        case 'pos': updatePos(ws, m); break;
        case 'view': setView(ws, m); break;
        case 'act': act(ws, m); break;
        case 'stats': send(ws, { t: 'stats', stats: statsCache || computeStats() }); break;
        case 'ping': send(ws, { t: 'pong' }); break;
      }
    } catch (e) { console.error('Ошибка обработки', m && m.t, e); send(ws, { t: 'err', text: 'Ошибка сервера' }); }
  });
  ws.on('close', () => clients.delete(ws));
});

// ───────────────────────── Запуск ─────────────────────────
load();
recountPlayers();
computeStats();
setInterval(incomeTick, 60_000);
setInterval(() => { const s = computeStats(); for (const ws of clients) if (ws.player) send(ws, { t: 'stats', stats: s }); }, 10_000);
setInterval(save, 10_000);
setInterval(() => { for (const ws of clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 30_000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty = true; save(); process.exit(0); });

server.listen(CFG.PORT, () => console.log(`Сервер запущен: http://localhost:${CFG.PORT}  ${CFG.DEV ? '(DEV: ручной GPS разрешён)' : ''}`));
