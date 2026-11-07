/* Захват территорий — клиент */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many; };
  const players = (n) => `${n} ${plural(n, 'игрок', 'игрока', 'игроков')}`;
  const hexes = (n) => `${n} ${plural(n, 'гекс', 'гекса', 'гексов')}`;
  const COLORS = { 1: '#ff6a2b', 2: '#1fd1e8' };
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let CFG = null;
  let me = null;
  let ws = null, wsBackoff = 1000;
  let pos = null;              // {lat,lng,acc}
  let devMode = false;
  let selected = null;         // h3 id
  let followMe = true;
  const cells = new Map();     // h3 -> {id,f,hp,owner,clan}
  const polys = new Map();     // h3 -> L.Polygon
  let regions = new Set();

  // ───────── Карта ─────────
  const map = L.map('map', { zoomControl: true, attributionControl: true, preferCanvas: true, minZoom: 3, maxZoom: 19, worldCopyJump: true })
    .setView([59.9087, 30.5139], 15); // Кудрово по умолчанию
  // Тайлы OpenStreetMap; тёмный вид делается CSS-фильтром (.leaflet-tile-pane в style.css)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const renderer = L.canvas({ padding: 0.3 });
  const gridLayer = L.layerGroup().addTo(map);
  const cellLayer = L.layerGroup().addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);
  const selLayer = L.layerGroup().addTo(map);
  let meMarker = null, accCircle = null;

  const boundary = (id) => h3.cellToBoundary(id);

  function cellStyle(c) {
    const col = COLORS[c.f];
    return { renderer, color: col, weight: 1.2, opacity: 0.85, fillColor: col, fillOpacity: 0.18 + c.hp * 0.08, interactive: false };
  }
  function drawCell(c, flash) {
    let p = polys.get(c.id);
    if (!c.f) { if (p) { cellLayer.removeLayer(p); polys.delete(c.id); } return; }
    const st = cellStyle(c);
    if (!p) { p = L.polygon(boundary(c.id), st); cellLayer.addLayer(p); polys.set(c.id, p); }
    else p.setStyle(st);
    if (flash) {
      p.setStyle({ fillOpacity: 0.95, weight: 3, color: '#ffffff' });
      setTimeout(() => p.setStyle(st), 450);
    }
  }

  function drawGrid() {
    gridLayer.clearLayers();
    if (!CFG || map.getZoom() < 15) return;
    const b = map.getBounds().pad(0.1);
    const ring = [[b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()], [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()]];
    let ids;
    try { ids = h3.polygonToCells(ring, CFG.res); } catch { return; }
    if (ids.length > 2500) return;
    for (const id of ids) {
      gridLayer.addLayer(L.polygon(boundary(id), { renderer, color: '#ffffff', weight: 0.6, opacity: 0.09, fill: false, interactive: false }));
    }
  }

  function zoneCells() {
    if (!pos || !CFG) return new Set();
    return new Set(h3.gridDisk(h3.latLngToCell(pos.lat, pos.lng, CFG.res), CFG.ring));
  }
  function drawZone() {
    zoneLayer.clearLayers();
    if (!pos || !CFG) return;
    const ids = [...zoneCells()];
    const shape = h3.cellsToMultiPolygon(ids, false);
    for (const poly of shape) {
      zoneLayer.addLayer(L.polygon(poly, { renderer, color: '#ffffff', weight: 2, opacity: 0.75, dashArray: '6 6', fillColor: '#ffffff', fillOpacity: 0.04, interactive: false }));
    }
  }

  function drawMe() {
    if (!pos) return;
    const ll = [pos.lat, pos.lng];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false }).addTo(map);
      accCircle = L.circle(ll, { renderer, radius: pos.acc, color: '#ffffff', weight: 1, opacity: 0.25, fillOpacity: 0.05, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll); accCircle.setRadius(Math.min(pos.acc, 2000)); }
  }

  function updateRegions() {
    if (!CFG || !ws || ws.readyState !== 1) return;
    const b = map.getBounds().pad(0.2);
    const ring = [[b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()], [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()]];
    const set = new Set();
    try { for (const r of h3.polygonToCells(ring, CFG.regionRes)) set.add(r); } catch {}
    for (const ll of [...ring, [map.getCenter().lat, map.getCenter().lng]]) {
      for (const r of h3.gridDisk(h3.latLngToCell(ll[0], ll[1], CFG.regionRes), 1)) set.add(r);
    }
    if (pos) for (const r of h3.gridDisk(h3.latLngToCell(pos.lat, pos.lng, CFG.regionRes), 1)) set.add(r);
    let list = [...set];
    if (list.length > 80) list = list.slice(0, 80);
    // убираем гексы из регионов, на которые больше не подписаны
    const keep = new Set(list);
    for (const [id] of cells) if (!keep.has(h3.cellToParent(id, CFG.regionRes))) { cells.delete(id); drawCell({ id, f: 0 }); }
    regions = keep;
    send({ t: 'view', regions: list });
  }

  // ───────── Выбор гекса и действие ─────────
  function select(id) {
    selected = id;
    selLayer.clearLayers();
    if (!id) { $('sheet').hidden = true; return; }
    selLayer.addLayer(L.polygon(boundary(id), { renderer, color: '#ffffff', weight: 3, opacity: 1, fill: false, interactive: false }));
    renderSheet();
  }

  function renderSheet() {
    if (!selected || !me) return;
    $('sheet').hidden = false;
    const c = cells.get(selected) || { f: 0 };
    const inZone = zoneCells().has(selected);
    const title = $('cellTitle'), sub = $('cellSub'), btn = $('btnAct'), hp = $('cellHp');
    title.className = 'sheet-title' + (c.f ? ' f' + c.f : '');
    btn.className = 'act';
    hp.innerHTML = '';
    if (c.f) {
      hp.style.color = COLORS[c.f];
      for (let i = 1; i <= CFG.maxHp; i++) { const el = document.createElement('i'); if (i <= c.hp) el.className = 'on'; hp.appendChild(el); }
    }
    if (!c.f) {
      title.textContent = 'Нейтральная зона';
      btn.textContent = 'Захватить';
    } else if (c.f === me.faction) {
      title.textContent = (c.clan ? `[${c.clan}] ` : '') + c.owner;
      btn.textContent = c.hp >= CFG.maxHp ? 'Максимум' : `Укрепить · ${CFG.reinforceCost}`;
    } else {
      title.textContent = (c.clan ? `[${c.clan}] ` : '') + c.owner;
      btn.textContent = 'Атаковать';
      btn.classList.add('attack');
    }
    const facName = c.f ? CFG.factions.find(f => f.id === c.f).name : '';
    let reason = '';
    if (!pos) reason = 'Включите геолокацию, чтобы играть';
    else if (!inZone) reason = 'Далеко. Захват — только рядом с вами';
    else if (pos.acc > CFG.maxAcc && !devMode) reason = `Слабый GPS: ±${Math.round(pos.acc)} м`;
    else if (c.f === me.faction && c.hp >= CFG.maxHp) reason = 'Гекс полностью укреплён';
    else if (c.f === me.faction && me.coins < CFG.reinforceCost) reason = `Нужно ${CFG.reinforceCost} монет`;
    else if (c.f !== me.faction && me.energy < 1) reason = 'Нет энергии, подождите';
    sub.textContent = reason || (c.f ? `${facName} · прочность ${c.hp}/${CFG.maxHp}` : 'Свободно. Стоит 1 энергию');
    btn.disabled = !!reason;
  }

  map.on('click', (e) => {
    if (!CFG || !me) return;
    if (devMode) {
      setPos({ lat: e.latlng.lat, lng: e.latlng.lng, acc: 5 }, true);
      return;
    }
    const id = h3.latLngToCell(e.latlng.lat, e.latlng.lng, CFG.res);
    select(id === selected ? null : id);
  });
  map.on('dragstart', () => { followMe = false; });
  map.on('moveend', () => { drawGrid(); updateRegions(); });

  $('btnAct').addEventListener('click', () => {
    if (!selected) return;
    if (pos) send({ t: 'pos', lat: pos.lat, lng: pos.lng, acc: pos.acc, manual: devMode || undefined });
    send({ t: 'act', cell: selected });
    if (navigator.vibrate) navigator.vibrate(30);
  });

  // ───────── GPS ─────────
  let lastPosSent = 0;
  function setPos(p, manual) {
    pos = p;
    drawMe(); drawZone();
    const t = Date.now();
    if (manual || t - lastPosSent > 3000) { send({ t: 'pos', lat: p.lat, lng: p.lng, acc: p.acc, manual: manual || undefined }); lastPosSent = t; }
    if (followMe) map.panTo([p.lat, p.lng], { animate: true });
    renderSheet();
    $('gpsBanner').hidden = true;
  }
  function startGps() {
    if (!('geolocation' in navigator)) { showBanner('Это устройство не поддерживает геолокацию'); return; }
    navigator.geolocation.watchPosition(
      (g) => { if (!devMode) setPos({ lat: g.coords.latitude, lng: g.coords.longitude, acc: g.coords.accuracy }); },
      (err) => {
        if (devMode) return;
        if (err.code === 1) showBanner('Разрешите доступ к геопозиции — без неё захват невозможен');
        else showBanner('Ищем GPS-сигнал…');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    // держим позицию на сервере свежей
    setInterval(() => { if (pos) { send({ t: 'pos', lat: pos.lat, lng: pos.lng, acc: pos.acc, manual: devMode || undefined }); lastPosSent = Date.now(); } }, 20000);
  }
  function showBanner(text) { const b = $('gpsBanner'); b.textContent = text; b.hidden = false; }

  $('btnLocate').addEventListener('click', () => {
    followMe = true;
    if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16));
    else showBanner('Позиция ещё не определена');
  });

  $('btnDev').addEventListener('click', () => {
    devMode = !devMode;
    $('btnDev').classList.toggle('on', devMode);
    toast(devMode ? 'Тестовый режим: нажмите на карту, чтобы переместиться' : 'Тестовый режим выключен, используется GPS', 'info');
    if (devMode) { $('gpsBanner').hidden = true; followMe = false; }
  });

  // ───────── Сеть ─────────
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsBackoff = 1000;
      regions = new Set();
      const token = LS.get('tz_token');
      if (token) send({ t: 'hello', token }); else showOnboard();
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = () => { setTimeout(connect, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 15000); if (me) toast('Связь потеряна, переподключаемся…', 'warn'); };
  }

  function handle(m) {
    switch (m.t) {
      case 'need_register': showOnboard(); break;
      case 'registered': LS.set('tz_token', m.token); setMe(m.me); $('onboard').hidden = true; startGame(true); break;
      case 'me': { const first = !me; setMe(m.me); if (first) startGame(false); break; }
      case 'cells': for (const c of m.cells) { cells.set(c.id, c); drawCell(c); } renderSheet(); break;
      case 'cell': {
        const prev = cells.get(m.cell.id);
        cells.set(m.cell.id, m.cell);
        drawCell(m.cell, !prev || prev.f !== m.cell.f);
        if (m.cell.id === selected) renderSheet();
        break;
      }
      case 'toast': toast(m.text, m.kind); break;
      case 'err': toast(m.text, 'err'); if (!$('onboard').hidden) $('onErr').textContent = m.text; break;
      case 'stats': renderStats(m.stats); break;
      case 'clans': renderClanList(m.list); break;
    }
  }

  function setMe(p) {
    me = p;
    document.body.dataset.faction = p.faction;
    const f = CFG.factions.find(x => x.id === p.faction);
    $('meFaction').textContent = (p.clan ? `[${p.clan.tag}] ` : '') + p.name + ' · ' + f.name;
    $('meCoins').textContent = p.coins;
    $('meEnergy').textContent = p.energy;
    $('meEnergyMax').textContent = '/' + p.energyMax;
    $('meCells').textContent = p.cells;
    if (!$('clanModal').hidden) renderClanModal();
    renderSheet();
  }

  let started = false;
  function startGame(fresh) {
    if (started) { updateRegions(); return; }
    started = true;
    $('hud').hidden = false; $('fab').hidden = false;
    if (CFG.dev) $('btnDev').hidden = false;
    startGps();
    updateRegions(); drawGrid();
    send({ t: 'stats' });
    if (fresh) openClan();
  }

  // ───────── Онбординг ─────────
  let chosenFaction = 0;
  function showOnboard() {
    $('onboard').hidden = false;
    fetch('/api/stats').then(r => r.json()).then(s => {
      for (const f of s.factions) $('fInfo' + f.id).textContent = `${players(f.players)} · ${hexes(f.cells)}`;
    }).catch(() => {});
  }
  document.querySelectorAll('.fcard').forEach(b => b.addEventListener('click', () => {
    chosenFaction = Number(b.dataset.f);
    document.querySelectorAll('.fcard').forEach(x => x.classList.toggle('sel', x === b));
    document.body.dataset.faction = chosenFaction;
    checkStart();
  }));
  $('inName').addEventListener('input', checkStart);
  function checkStart() { $('btnStart').disabled = !(chosenFaction && $('inName').value.trim().length >= 2); }
  $('btnStart').addEventListener('click', () => { $('onErr').textContent = ''; send({ t: 'register', name: $('inName').value, faction: chosenFaction }); });

  // ───────── Кланы ─────────
  function openClan() { $('clanModal').hidden = false; renderClanModal(); }
  function renderClanModal() {
    const has = !!(me && me.clan);
    $('clanMine').hidden = !has; $('clanNone').hidden = has;
    $('clanTitle').textContent = has ? 'Ваш клан' : 'Кланы · ' + (CFG.factions.find(f => f.id === me.faction).name);
    if (has) {
      $('myClanTag').textContent = me.clan.tag; $('myClanTag').className = 'tag f' + me.faction;
      $('myClanName').textContent = me.clan.name;
      $('myClanMembers').textContent = me.clan.members;
      $('myClanTreasury').textContent = me.clan.treasury + ' монет';
      $('myClanRole').textContent = me.clan.leader ? 'Лидер' : 'Боец';
    } else send({ t: 'clans' });
  }
  function renderClanList(list) {
    const ul = $('clanList'); ul.innerHTML = '';
    if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Кланов пока нет — создайте первый'; ul.appendChild(li); return; }
    for (const c of list) {
      const li = document.createElement('li');
      const tag = document.createElement('span'); tag.className = 'tag f' + me.faction; tag.textContent = c.tag;
      const name = document.createElement('span'); name.className = 'grow'; name.textContent = c.name;
      const num = document.createElement('span'); num.className = 'num'; num.textContent = `${c.members} чел · ${hexes(c.cells)}`;
      const btn = document.createElement('button'); btn.className = 'join'; btn.textContent = 'Вступить';
      btn.addEventListener('click', () => send({ t: 'clan_join', id: c.id }));
      li.append(tag, name, num, btn); ul.appendChild(li);
    }
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t.dataset.tab; });
  }));
  $('btnCreateClan').addEventListener('click', () => send({ t: 'clan_create', name: $('inClanName').value, tag: $('inClanTag').value }));
  $('btnLeave').addEventListener('click', () => send({ t: 'clan_leave' }));
  $('btnClan').addEventListener('click', openClan);

  // ───────── Рейтинг ─────────
  let lastStats = null;
  function renderStats(s) {
    lastStats = s;
    const [a, b] = s.factions;
    const total = a.cells + b.cells;
    $('scoreF1').style.flexGrow = total ? a.cells : 1;
    $('scoreF2').style.flexGrow = total ? b.cells : 1;
    $('scoreN1').textContent = a.cells.toLocaleString('ru');
    $('scoreN2').textContent = b.cells.toLocaleString('ru');
    $('online').textContent = 'онлайн: ' + s.online;
    if (!$('topModal').hidden) renderTop();
  }
  function renderTop() {
    const s = lastStats; if (!s) return;
    const ft = $('facTotals'); ft.innerHTML = '';
    for (const f of s.factions) {
      const d = document.createElement('div'); d.className = 'f' + f.id;
      d.innerHTML = `<small></small><b></b><small></small>`;
      d.children[0].textContent = f.name; d.children[1].textContent = f.cells.toLocaleString('ru'); d.children[2].textContent = `${plural(f.cells, 'гекс', 'гекса', 'гексов')} · ${players(f.players)}`;
      ft.appendChild(d);
    }
    fillRank($('topClans'), s.topClans, (x) => [x.tag, x.name, hexes(x.cells)], 'Кланы ещё не захватили территорию');
    fillRank($('topPlayers'), s.topPlayers, (x) => [x.clan, x.name, hexes(x.cells)], 'Будьте первым');
  }
  function fillRank(ol, rows, fmt, empty) {
    ol.innerHTML = '';
    if (!rows.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = empty; ol.appendChild(li); return; }
    for (const r of rows) {
      const [tag, name, num] = fmt(r);
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'dot f' + r.faction; li.appendChild(dot);
      if (tag) { const t = document.createElement('span'); t.className = 'tag f' + r.faction; t.textContent = tag; li.appendChild(t); }
      const n = document.createElement('span'); n.className = 'grow'; n.textContent = name;
      const v = document.createElement('span'); v.className = 'num'; v.textContent = num;
      li.append(n, v); ol.appendChild(li);
    }
  }
  $('btnTop').addEventListener('click', () => { $('topModal').hidden = false; renderTop(); send({ t: 'stats' }); });

  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'onboard') m.hidden = true; }));

  // ───────── Тосты ─────────
  function toast(text, kind = 'info') {
    const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = text;
    const box = $('toasts'); box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2800);
  }

  // энергия тикает локально между обновлениями
  setInterval(() => { if (me && me.energy < me.energyMax && me.nextEnergyIn > 0) { me.nextEnergyIn -= 1000; if (me.nextEnergyIn <= 0) { me.energy++; me.nextEnergyIn = 30000; $('meEnergy').textContent = me.energy; renderSheet(); } } }, 1000);

  // ───────── Старт ─────────
  fetch('/api/config').then(r => r.json()).then(c => {
    CFG = c;
    $('ruleCost').textContent = c.reinforceCost; $('ruleIncome').textContent = c.incomePerHour;
    connect();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
