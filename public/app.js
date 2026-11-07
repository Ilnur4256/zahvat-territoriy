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
  let regions = new Set();

  // ───────── Карта: MapLibre + OpenFreeMap (данные OpenStreetMap) ─────────
  const ML = window.maplibregl;
  const map = new ML.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [30.5139, 59.9087], // Кудрово по умолчанию
    zoom: 14.5, minZoom: 3, maxZoom: 19,
    attributionControl: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  const narrow = matchMedia('(max-width: 640px)').matches;
  const attrib = new ML.AttributionControl({ compact: narrow });
  map.addControl(attrib, 'bottom-left');
  // на телефоне подпись свёрнута в значок ⓘ, полный текст — по нажатию
  if (narrow) map.once('idle', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  if (matchMedia('(pointer: fine)').matches) map.addControl(new ML.NavigationControl({ showCompass: false }), 'top-left');

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const boundary = (id) => { const r = h3.cellToBoundary(id, true); return r; }; // [lng,lat], замкнутое кольцо
  const hexFeature = (id, props = {}) => ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Polygon', coordinates: [boundary(id)] } });
  let mapReady = false;
  const pending = new Set();
  function setData(src, data) { const s = mapReady && map.getSource(src); if (s) s.setData(data); }

  map.on('load', () => {
    for (const id of ['grid', 'cells', 'flash', 'zone', 'sel', 'acc']) map.addSource(id, { type: 'geojson', data: EMPTY });
    const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id; // гексы под подписями улиц
    map.addLayer({ id: 'grid-line', type: 'line', source: 'grid', paint: { 'line-color': '#ffffff', 'line-opacity': 0.1, 'line-width': 0.6 } }, before);
    map.addLayer({ id: 'cells-fill', type: 'fill', source: 'cells', paint: {
      'fill-color': ['match', ['get', 'f'], 1, COLORS[1], COLORS[2]],
      'fill-opacity': ['+', 0.28, ['*', ['get', 'hp'], 0.09]],
    } }, before);
    map.addLayer({ id: 'cells-line', type: 'line', source: 'cells', paint: { 'line-color': ['match', ['get', 'f'], 1, COLORS[1], COLORS[2]], 'line-width': 1.2, 'line-opacity': 0.9 } }, before);
    map.addLayer({ id: 'flash-fill', type: 'fill', source: 'flash', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.75 } });
    map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.04 } });
    map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.75, 'line-dasharray': [3, 3] } });
    map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.05 } });
    map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#ffffff', 'line-width': 3 } });
    mapReady = true;
    redrawCells(); drawGrid(); drawZone(); drawMe(); if (selected) select(selected);
  });

  // Гексы перерисовываются одним обновлением источника, не чаще раза в кадр
  let cellsDirty = false;
  function redrawCells() {
    if (cellsDirty) return; cellsDirty = true;
    requestAnimationFrame(() => {
      cellsDirty = false;
      const fs = [];
      for (const c of cells.values()) if (c.f) fs.push(hexFeature(c.id, { f: c.f, hp: c.hp }));
      setData('cells', { type: 'FeatureCollection', features: fs });
    });
  }
  function drawCell(c, flash) {
    redrawCells();
    if (flash && c.f) { pending.add(c.id); flashNow(); setTimeout(() => { pending.delete(c.id); flashNow(); }, 450); }
  }
  function flashNow() { setData('flash', { type: 'FeatureCollection', features: [...pending].map(id => hexFeature(id)) }); }

  function boundsRing(pad) {
    const b = map.getBounds();
    const dLat = (b.getNorth() - b.getSouth()) * pad, dLng = (b.getEast() - b.getWest()) * pad;
    const s = b.getSouth() - dLat, n = b.getNorth() + dLat, w = b.getWest() - dLng, e = b.getEast() + dLng;
    return [[s, w], [n, w], [n, e], [s, e]];
  }

  function drawGrid() {
    if (!CFG || map.getZoom() < 13.5) { setData('grid', EMPTY); return; }
    let ids;
    try { ids = h3.polygonToCells(boundsRing(0.1), CFG.res); } catch { return; }
    if (ids.length > 3000) { setData('grid', EMPTY); return; }
    setData('grid', { type: 'FeatureCollection', features: ids.map(id => hexFeature(id)) });
  }

  function zoneCells() {
    if (!pos || !CFG) return new Set();
    return new Set(h3.gridDisk(h3.latLngToCell(pos.lat, pos.lng, CFG.res), CFG.ring));
  }
  function drawZone() {
    if (!pos || !CFG) { setData('zone', EMPTY); return; }
    const mp = h3.cellsToMultiPolygon([...zoneCells()], true);
    setData('zone', { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: mp } });
  }

  let meMarker = null;
  function circlePoly(lat, lng, r) {
    const pts = [], R = 6371000;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      pts.push([lng + (r * Math.sin(a)) / (R * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI, lat + (r * Math.cos(a)) / R * 180 / Math.PI]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
  }
  function drawMe() {
    if (!pos) return;
    if (!meMarker) {
      const el = document.createElement('div'); el.className = 'me-marker';
      meMarker = new ML.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(map);
    } else meMarker.setLngLat([pos.lng, pos.lat]);
    setData('acc', circlePoly(pos.lat, pos.lng, Math.min(pos.acc, 2000)));
  }

  function updateRegions() {
    if (!CFG || !ws || ws.readyState !== 1) return;
    const ring = boundsRing(0.2);
    const set = new Set();
    try { for (const r of h3.polygonToCells(ring, CFG.regionRes)) set.add(r); } catch {}
    const c = map.getCenter();
    for (const ll of [...ring, [c.lat, c.lng]]) {
      for (const r of h3.gridDisk(h3.latLngToCell(ll[0], ll[1], CFG.regionRes), 1)) set.add(r);
    }
    if (pos) for (const r of h3.gridDisk(h3.latLngToCell(pos.lat, pos.lng, CFG.regionRes), 1)) set.add(r);
    let list = [...set];
    if (list.length > 80) list = list.slice(0, 80);
    // убираем гексы из регионов, на которые больше не подписаны
    const keep = new Set(list);
    let removed = false;
    for (const [id] of cells) if (!keep.has(h3.cellToParent(id, CFG.regionRes))) { cells.delete(id); removed = true; }
    if (removed) redrawCells();
    regions = keep;
    send({ t: 'view', regions: list });
  }

  // ───────── Выбор гекса и действие ─────────
  function select(id) {
    selected = id;
    document.body.classList.toggle('sheet-open', !!id);
    if (!id) { setData('sel', EMPTY); $('sheet').hidden = true; return; }
    setData('sel', hexFeature(id));
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
      setPos({ lat: e.lngLat.lat, lng: e.lngLat.lng, acc: 5 }, true);
      return;
    }
    const id = h3.latLngToCell(e.lngLat.lat, e.lngLat.lng, CFG.res);
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
    if (followMe) map.easeTo({ center: [p.lng, p.lat], duration: 600 });
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
    if (pos) map.easeTo({ center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 14.5) });
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
