// Tank Arena — client
const $ = id => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
let CW = 0, CH = 0;
function resize() { CW = canvas.width = innerWidth; CH = canvas.height = innerHeight; }
addEventListener('resize', resize); resize();

let ws = null, myId = null, myToken = null, pendingRoom = null;
let mapData = null, prev = null, curr = null, recvAt = 0;
let mapIdx = 0, selColor = '#4d9bff';
const COLORS = ['#4d9bff', '#ff4d4d', '#54e36b', '#ffd24d', '#c44dff', '#4dffe0'];
const WEAPONS = [
  { id: 'cannon', icon: '💥', name: 'Cannon' },
  { id: 'mg', icon: '🔫', name: 'MG' },
  { id: 'shotgun', icon: '🟠', name: 'Shotgun' },
  { id: 'rail', icon: '⚡', name: 'Railgun' },
];
let myWeapon = 'cannon';
const TILE = 40;

// ---------- sprites ----------
function loadImg(s) { const i = new Image(); i.src = s; return i; }
const HULL_IMG = [0, 1, 2, 3].map(i => loadImg(`assets/hull/${i}.png`));
const SKIN_COL = ['#9c6b46', '#6f8a48', '#6b7682', '#4a5160']; // representative hull colours
const GUN_IMG = { cannon: loadImg('assets/gun/cannon.png'), mg: loadImg('assets/gun/mg.png'), shotgun: loadImg('assets/gun/shotgun.png'), rail: loadImg('assets/gun/rail.png') };
const SHELL_IMG = { cannon: loadImg('assets/shell/cannon.png'), mg: loadImg('assets/shell/mg.png'), shotgun: loadImg('assets/shell/shotgun.png'), rail: loadImg('assets/shell/rail.png') };
const EXPL_FR = []; for (let i = 0; i < 9; i++) EXPL_FR.push(loadImg(`assets/explosion/${i}.png`));
const FLASH_FR = []; for (let i = 0; i < 5; i++) FLASH_FR.push(loadImg(`assets/flash/${i}.png`));
const HULL_PX = 42, GUN_PIVOT = 0.72; // hull draw size; gun rotation pivot (fraction down the image)
let selSkin = 0;
const input = { up: false, down: false, left: false, right: false, shoot: false, aim: 0 };
let lastSent = '';
const explosionsSeen = new Set();

// ---------- AUDIO ----------
const Snd = (() => {
  let ac, master;
  function ensure() { if (ac) return; ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = .35; master.connect(ac.destination); }
  function tone(f, d, type = 'square', v = .4, slideTo) {
    ensure(); const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ac.currentTime + d);
    g.gain.setValueAtTime(v, ac.currentTime); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + d);
    o.connect(g); g.connect(master); o.start(); o.stop(ac.currentTime + d);
  }
  return {
    resume() { ensure(); if (ac.state === 'suspended') ac.resume(); },
    shoot(w) { if (w === 'rail') tone(900, .25, 'sawtooth', .3, 200); else if (w === 'mg') tone(420, .05, 'square', .2); else if (w === 'shotgun') tone(180, .15, 'square', .35, 80); else tone(260, .12, 'square', .4, 120); },
    boom() { tone(150, .4, 'sawtooth', .5, 40); },
    pick() { tone(660, .08); setTimeout(() => tone(990, .12), 60); },
  };
})();

// ---------- classic title screen ----------
(function () {
  const title = $('title'); let started = false;
  function start() {
    if (started) return; started = true;
    Snd.resume();
    title.style.transition = 'opacity .4s'; title.style.opacity = '0';
    setTimeout(() => { title.style.display = 'none'; }, 400);
    $('home').classList.remove('hidden');
    $('name').focus();
  }
  title.addEventListener('click', start);
  addEventListener('keydown', start);
})();

// ---------- nav ----------
function showOverlay(id) { ['home', 'createPanel', 'joinPanel', 'lobby', 'win', 'status'].forEach(o => $(o).classList.toggle('hidden', o !== id)); }
function buildSwatches() {
  const w = $('swatches'); w.innerHTML = '';
  SKIN_COL.forEach((c, i) => { const s = document.createElement('div'); s.className = 'sw' + (i === selSkin ? ' sel' : ''); s.style.background = c; s.title = 'Tank skin ' + (i + 1); s.onclick = () => { selSkin = i; selColor = c; buildSwatches(); }; w.appendChild(s); });
  selColor = SKIN_COL[selSkin];
}
buildSwatches();
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
$('createChoice').onclick = () => { if (!$('name').value.trim()) return $('name').focus(); $('genCode').textContent = genCode(); showOverlay('createPanel'); };
$('joinChoice').onclick = () => { if (!$('name').value.trim()) return $('name').focus(); showOverlay('joinPanel'); $('room').focus(); };
$('backCreate').onclick = () => showOverlay('home');
$('backJoin').onclick = () => showOverlay('home');
$('copyBtn').onclick = () => { navigator.clipboard?.writeText($('genCode').textContent); $('copyBtn').textContent = '✓ Copied'; setTimeout(() => $('copyBtn').textContent = '📋 Copy code', 1500); };
$('createJoinBtn').onclick = () => { pendingRoom = $('genCode').textContent; connect(); };
$('joinBtn').onclick = () => { const c = $('room').value.trim(); if (!/^\d{6}$/.test(c)) { $('room').focus(); return; } pendingRoom = c; connect(); };
document.querySelectorAll('#mapOpts .opt').forEach(o => o.onclick = () => { mapIdx = +o.dataset.map; setMapUI(); if (ws) ws.send(JSON.stringify({ t: 'map', mapIdx })); });
function setMapUI() { document.querySelectorAll('#mapOpts .opt').forEach(o => o.classList.toggle('sel', +o.dataset.map === mapIdx)); }
setMapUI();
// weapon choice (fixed per tank, picked before joining)
document.querySelectorAll('#weaponOpts .opt').forEach(o => o.onclick = () => { myWeapon = o.dataset.wpn; setWeaponUI(); if (ws) ws.send(JSON.stringify({ t: 'weapon', weapon: myWeapon })); });
function setWeaponUI() { document.querySelectorAll('#weaponOpts .opt').forEach(o => o.classList.toggle('sel', o.dataset.wpn === myWeapon)); }
setWeaponUI();
$('startBtn').onclick = () => { Snd.resume(); ws.send(JSON.stringify({ t: 'start' })); };
$('againBtn').onclick = () => { ws.send(JSON.stringify({ t: 'start' })); };

// ---------- network ----------
function connect() {
  if (location.protocol === 'file:') { $('status').classList.remove('hidden'); $('statusMsg').textContent = 'Open via http://localhost:3001, not the file.'; return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onerror = () => { showOverlay('status'); $('statusMsg').textContent = 'Cannot reach server. Is it running?'; };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: $('name').value.trim() || 'Tank', room: pendingRoom || 'lobby', color: selColor, skin: selSkin, weapon: myWeapon, token: myToken }));
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { showOverlay('status'); $('statusMsg').textContent = 'Disconnected — refresh to rejoin.'; };
}
function handle(m) {
  if (m.t === 'joined') { myId = m.id; myToken = m.token; $('lobbyCode').textContent = m.room; showOverlay('lobby'); }
  else if (m.t === 'map') { mapData = m; mapIdx = m.mapIdx; setMapUI(); }
  else if (m.t === 'lobby') { mapIdx = m.mapIdx; setMapUI(); renderPlist(m.players); }
  else if (m.t === 'kill') { addFeed(m); }
  else if (m.t === 'state') {
    prev = curr; curr = m; recvAt = performance.now();
    // apply destroyed crates to the local map copy so they vanish
    if (m.crateBreaks && mapData && mapData.tiles) {
      m.crateBreaks.forEach(b => { const row = mapData.tiles[b.y]; if (row) mapData.tiles[b.y] = row.substring(0, b.x) + '0' + row.substring(b.x + 1); });
    }
    if (m.phase === 'playing') { $('hud').classList.remove('hidden'); showOverlay(''); }
    if (m.phase === 'over' && !winShown) showWin(m);
    if (m.phase !== 'over') winShown = false;
    // explosion sounds
    m.explosions.forEach(ex => { const k = ex.x + ',' + ex.y + ',' + ex.t; if (!explosionsSeen.has(k)) { explosionsSeen.add(k); Snd.boom(); } });
    if (explosionsSeen.size > 200) explosionsSeen.clear();
  }
}
let winShown = false;
function showWin(m) {
  winShown = true; $('hud').classList.add('hidden');
  const me = m.players.find(p => p.id === myId);
  $('winTitle').textContent = (me && m.winner === me.name) ? 'VICTORY 🏆' : m.winner + ' WINS';
  const board = [...m.players].sort((a, b) => b.kills - a.kills)
    .map(p => `<div style="display:flex;justify-content:space-between;color:${p.color};margin:4px 0;font-weight:700"><span>${p.name}</span><span>${p.kills} K / ${p.deaths} D</span></div>`).join('');
  $('winBoard').innerHTML = board;
  showOverlay('win');
}
function renderPlist(players) { const ul = $('plist'); ul.innerHTML = ''; players.forEach(p => { const li = document.createElement('li'); li.innerHTML = `<span class="sw" style="width:12px;height:12px;border:none;background:${p.color}"></span>${p.name}`; ul.appendChild(li); }); }
function addFeed(m) { const d = document.createElement('div'); d.className = 'feed'; const w = WEAPONS.find(x => x.id === m.w); d.innerHTML = `<b>${m.a}</b> ${w ? w.icon : '💥'} <b>${m.b}</b>`; $('killfeed').appendChild(d); setTimeout(() => d.remove(), 4000); }

// ---------- input ----------
const KEY = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = KEY[e.key.toLowerCase()];
  if (k) { input[k] = true; sendInput(); e.preventDefault(); }
  if (e.key === ' ') { input.shoot = true; sendInput(); e.preventDefault(); }
});
addEventListener('keyup', e => { const k = KEY[e.key.toLowerCase()]; if (k) { input[k] = false; sendInput(); } if (e.key === ' ') { input.shoot = false; sendInput(); } });
canvas.addEventListener('mousemove', e => { aimAt(e.clientX, e.clientY); });
canvas.addEventListener('mousedown', () => { Snd.resume(); input.shoot = true; sendInput(); });
addEventListener('mouseup', () => { input.shoot = false; sendInput(); });
// touch: left half move joystick, right half aim+shoot — simple: drag aims & shoots, two-finger handled minimally
canvas.addEventListener('touchstart', e => { Snd.resume(); for (const t of e.touches) handleTouch(t); input.shoot = true; sendInput(); e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', e => { for (const t of e.touches) handleTouch(t); e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend', e => { if (e.touches.length === 0) { input.shoot = false; input.up = input.down = input.left = input.right = false; sendInput(); } e.preventDefault(); }, { passive: false });
function handleTouch(t) { if (t.clientX < CW / 2) { const me = meTank(); if (me) { const w = worldFromScreen(t.clientX, t.clientY); const a = Math.atan2(w.y - me.y, w.x - me.x); input.up = true; input.aimMove = a; } } else aimAt(t.clientX, t.clientY); sendInput(); }

function aimAt(sx, sy) { const me = meTank(); if (!me) return; const w = worldFromScreen(sx, sy); input.aim = Math.atan2(w.y - me.y, w.x - me.x); sendInput(); }
function meTank() { return curr && curr.players.find(p => p.id === myId); }
function sendInput() {
  if (!ws || ws.readyState !== 1) return;
  const sig = [input.up, input.down, input.left, input.right, input.shoot, Math.round(input.aim * 20)].join(',');
  if (sig === lastSent) return; lastSent = sig;
  ws.send(JSON.stringify({ t: 'input', up: input.up, down: input.down, left: input.left, right: input.right, shoot: input.shoot, aim: input.aim }));
}

// ---------- view transform ----------
let view = { scale: 1, ox: 0, oy: 0 };
function computeView() {
  if (!mapData) return;
  const mw = mapData.w * TILE, mh = mapData.h * TILE;
  const s = Math.min(CW / mw, CH / mh) * 0.98;
  view.scale = s; view.ox = (CW - mw * s) / 2; view.oy = (CH - mh * s) / 2;
}
function worldFromScreen(sx, sy) { return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale }; }

// ---------- weapons UI ----------
function showWeaponBadge() {
  const me = curr && curr.players.find(p => p.id === myId);
  const id = me ? me.weapon : myWeapon;
  const w = WEAPONS.find(x => x.id === id) || WEAPONS[0];
  const wrap = $('weapons'); wrap.innerHTML = `<div class="wpn sel">${w.icon}<small>${w.name}</small></div>`;
}

// ---------- render ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAng(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }
function interp() {
  if (!curr) return null;
  const t = prev ? Math.min(1, (performance.now() - recvAt) / TICKMS) : 1;
  const map = (arr, parr, key, ang) => arr.map(e => {
    const pe = parr && parr.find(x => x[key] === e[key]);
    if (!pe) return e;
    const o = { ...e, x: lerp(pe.x, e.x, t), y: lerp(pe.y, e.y, t) };
    if (ang) { o.angle = lerpAng(pe.angle, e.angle, t); o.turret = lerpAng(pe.turret, e.turret, t); }
    return o;
  });
  return { ...curr, players: map(curr.players, prev && prev.players, 'id', true), bullets: map(curr.bullets, prev && prev.bullets, 'id') };
}
const TICKMS = 1000 / 30;

const PICK_ICON = { health: '➕', shield: '🛡️', speed: '⚡', damage: '🔺' };
const PICK_COL = { health: '#54e36b', shield: '#7ee0ff', speed: '#ffd24d', damage: '#ff6a6a' };

function render() {
  requestAnimationFrame(render);
  ctx.fillStyle = '#0c1018'; ctx.fillRect(0, 0, CW, CH);
  if (!mapData) return;
  computeView();
  ctx.save();
  ctx.translate(view.ox, view.oy); ctx.scale(view.scale, view.scale);
  const mw = mapData.w * TILE, mh = mapData.h * TILE;

  // floor
  ctx.fillStyle = '#161c28'; ctx.fillRect(0, 0, mw, mh);
  ctx.strokeStyle = 'rgba(255,255,255,.03)'; ctx.lineWidth = 1;
  for (let x = 0; x <= mapData.w; x++) { ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, mh); ctx.stroke(); }
  for (let y = 0; y <= mapData.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * TILE); ctx.lineTo(mw, y * TILE); ctx.stroke(); }
  // tiles
  for (let y = 0; y < mapData.h; y++) for (let x = 0; x < mapData.w; x++) {
    const c = mapData.tiles[y][x];
    if (c === '1') { drawWall(x * TILE, y * TILE); }
    else if (c === '2') { drawCrate(x * TILE, y * TILE); }
  }

  const st = interp();
  if (st) {
    // pickups
    st.pickups.forEach(pk => {
      const bob = Math.sin(performance.now() / 300 + pk.id) * 3;
      ctx.fillStyle = PICK_COL[pk.type]; ctx.globalAlpha = .18; ctx.beginPath(); ctx.arc(pk.x, pk.y + bob, 16, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.font = '20px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(PICK_ICON[pk.type], pk.x, pk.y + bob + 1);
    });
    // bullets (shell sprites)
    ctx.imageSmoothingEnabled = true;
    st.bullets.forEach(b => {
      const img = SHELL_IMG[b.w];
      if (img && img.complete && img.naturalWidth) {
        const size = (b.r + 6) * 2.4;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate((b.a || 0) + Math.PI / 2);
        ctx.drawImage(img, -size / 2, -size / 2, size, size); ctx.restore();
      } else { ctx.fillStyle = b.c; ctx.shadowColor = b.c; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0; }
    });
    // tanks
    st.players.forEach(p => { if (!p.disconnected) drawTank(p); });
    // explosions (animated sprite sheet)
    (curr.explosions || []).forEach(ex => {
      const age = (Date.now() - ex.t) / 600; if (age > 1) return;
      const fi = Math.min(EXPL_FR.length - 1, Math.floor(age * EXPL_FR.length));
      const img = EXPL_FR[fi];
      const sz = ex.small ? 38 : 80;
      if (img && img.complete && img.naturalWidth) { ctx.drawImage(img, ex.x - sz / 2, ex.y - sz / 2, sz, sz); }
      else { ctx.globalAlpha = 1 - age; ctx.fillStyle = '#ffb24d'; ctx.beginPath(); ctx.arc(ex.x, ex.y, sz / 2 * (0.5 + age), 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
    });
  }
  ctx.restore();
  if (st) updateHUD(st);
}

function drawWall(x, y) {
  ctx.fillStyle = '#39435a'; ctx.fillRect(x, y, TILE, TILE);
  ctx.fillStyle = '#2c344a'; ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
  ctx.strokeStyle = '#475270'; ctx.lineWidth = 2; ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
}
function drawCrate(x, y) {
  ctx.fillStyle = '#8a5a2b'; ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
  ctx.strokeStyle = '#5e3c1c'; ctx.lineWidth = 3; ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
  ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + TILE - 4, y + TILE - 4); ctx.moveTo(x + TILE - 4, y + 4); ctx.lineTo(x + 4, y + TILE - 4); ctx.stroke();
}
function drawTank(p) {
  ctx.save(); ctx.translate(p.x, p.y);
  if (!p.alive) ctx.globalAlpha = .28;
  ctx.imageSmoothingEnabled = true;
  // hull
  const hull = HULL_IMG[p.skin || 0];
  if (hull && hull.complete && hull.naturalWidth) {
    ctx.save(); ctx.rotate(p.angle + Math.PI / 2);
    ctx.drawImage(hull, -HULL_PX / 2, -HULL_PX / 2, HULL_PX, HULL_PX);
    ctx.restore();
  } else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(0, 0, 16, 0, 7); ctx.fill(); }
  // turret / gun
  const gun = GUN_IMG[p.weapon];
  if (gun && gun.complete && gun.naturalWidth) {
    const gs = HULL_PX / 256;
    const gw = gun.naturalWidth * gs, gh = gun.naturalHeight * gs;
    ctx.save(); ctx.rotate(p.turret + Math.PI / 2);
    ctx.drawImage(gun, -gw / 2, -gh * GUN_PIVOT, gw, gh);
    if (p.muzzle) {
      const ff = FLASH_FR[Math.floor(performance.now() / 25) % FLASH_FR.length];
      if (ff && ff.complete) { const fs = gw * 2.2; ctx.drawImage(ff, -fs / 2, -gh * GUN_PIVOT - fs * 0.55, fs, fs); }
    }
    ctx.restore();
  }
  if (p.shield > 0) { ctx.strokeStyle = '#7ee0ff'; ctx.lineWidth = 2; ctx.globalAlpha = (p.alive ? .7 : .2); ctx.beginPath(); ctx.arc(0, 0, 24, 0, 7); ctx.stroke(); }
  ctx.restore();
  // name + hp bar (screen-aligned)
  ctx.fillStyle = p.id === myId ? '#fff' : p.color; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(p.name, p.x, p.y - 28);
  if (p.alive && p.hp < p.maxHp) { ctx.fillStyle = '#311'; ctx.fillRect(p.x - 18, p.y - 24, 36, 4); ctx.fillStyle = '#ff6a6a'; ctx.fillRect(p.x - 18, p.y - 24, 36 * p.hp / p.maxHp, 4); }
}
function roundRectP(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function shade(hex, a) { const n = parseInt(hex.slice(1), 16); let r = (n >> 16) + a, g = ((n >> 8) & 255) + a, b = (n & 255) + a; r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b)); return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); }

let prevMuzzle = {}, badgeWeapon = null;
function updateHUD(st) {
  // scoreboard
  const sb = $('scoreboard');
  sb.innerHTML = [...st.players].sort((a, b) => b.kills - a.kills).map(p =>
    `<span class="s"><span class="dot" style="background:${p.color}"></span>${p.name} ${p.kills}</span>`).join('');
  const me = st.players.find(p => p.id === myId);
  if (me) {
    if (me.weapon !== badgeWeapon) { badgeWeapon = me.weapon; showWeaponBadge(); }
    $('hpFill').style.width = (100 * me.hp / me.maxHp) + '%';
    $('hpLabel').textContent = me.hp + ' HP';
    $('shFill').style.width = (me.shield ? Math.min(100, me.shield * 1.6) : 0) + '%';
    const rs = $('respawn');
    if (!me.alive) { rs.classList.remove('hidden'); rs.textContent = 'RESPAWN IN ' + me.respawnIn; }
    else rs.classList.add('hidden');
    // muzzle sound
    if (me.muzzle && !prevMuzzle[me.id]) Snd.shoot(me.weapon);
  }
  st.players.forEach(p => prevMuzzle[p.id] = p.muzzle);
}

render();
