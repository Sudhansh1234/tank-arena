// Tank Arena — authoritative multiplayer server
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;

// ---- static files ----
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('no'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    const TYPES = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json',
    };
    const type = TYPES[ext] || 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

// ---- constants ----
const TILE = 40;
const TICK = 1000 / 30;
const TANK_R = 15;
const RESPAWN = 3000;

// ---- weapons ----
const WEAPONS = {
  cannon:  { name: 'Cannon',      icon: '💥', cd: 0.65, dmg: 24, speed: 560, r: 5,  life: 2.4, pellets: 1, spread: 0,    pierceWall: false, color: '#ffd24d', bounce: 2 },
  mg:      { name: 'Machine Gun', icon: '🔫', cd: 0.10, dmg: 7,  speed: 680, r: 3,  life: 0.8, pellets: 1, spread: 0.08, pierceWall: false, color: '#7ee0ff' },
  shotgun: { name: 'Shotgun',     icon: '🟠', cd: 0.85, dmg: 9,  speed: 520, r: 4,  life: 0.45,pellets: 6, spread: 0.42, pierceWall: false, color: '#ff9d3a' },
  rail:    { name: 'Railgun',     icon: '⚡', cd: 1.5,  dmg: 60, speed: 1300,r: 4,  life: 0.9, pellets: 1, spread: 0,    pierceWall: true,  color: '#ff5fb0', pierceTanks: true },
};
const WEAPON_KEYS = ['cannon', 'mg', 'shotgun', 'rail'];

// ---- maps (# wall, X crate, . floor, S spawn) ----
const MAPS = [
  {
    name: 'Crossfire',
    grid: [
      '########################',
      '#S....#..........#....S#',
      '#.....#....XX.....#.....#',
      '#.....X....XX....X.....#',
      '#..........XX..........#',
      '#...XX...............XX.#',
      '#...XX......##.....XX...#',
      '#..........####........#',
      '#..........####........#',
      '#...XX......##.....XX...#',
      '#...XX...............XX.#',
      '#..........XX..........#',
      '#.....X....XX....X.....#',
      '#.....#....XX.....#.....#',
      '#S....#..........#....S#',
      '########################',
    ],
  },
  {
    name: 'Maze',
    grid: [
      '########################',
      '#S...........#........S.#',
      '#.####.####..#..####.##.#',
      '#....#....#.....#....#..#',
      '#.##.#.##.#####.#.##.#.##',
      '#.#....#.......#..#.....#',
      '#.#.####.#####.####.###.#',
      '#...#......X......#....#.#',
      '#.#.#.####.#.####.#.##.#.#',
      '#.#......#.#....#....#..#',
      '#.####.#.#.####.####.#.##',
      '#....#.#......#.....#...#',
      '#.##.#.######.#.###.##.##',
      '#..#.........#........#.#',
      '#S.#...####......####..S#',
      '########################',
    ],
  },
  {
    name: 'Arena',
    grid: [
      '########################',
      '#S....................S.#',
      '#..XX..............XX...#',
      '#..XX...XXXXXXXX...XX...#',
      '#.......X......X........#',
      '#.......X......X........#',
      '#.......X......X........#',
      '#.......X......X........#',
      '#.......X......X........#',
      '#.......X......X........#',
      '#.......XXXXXXXX........#',
      '#..XX..............XX...#',
      '#..XX..............XX...#',
      '#S....................S.#',
      '########################',
      '########################',
    ],
  },
];

const COLORS = ['#4d9bff', '#ff4d4d', '#54e36b', '#ffd24d', '#c44dff', '#4dffe0'];
const PICKUP_TYPES = ['health', 'shield', 'speed', 'damage'];

const rooms = new Map();
let nextPid = 1;

function buildMap(idx) {
  const m = MAPS[idx % MAPS.length];
  const grid = m.grid;
  const h = grid.length, w = grid[0].length;
  const tiles = []; const spawns = []; const crates = {};
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    for (let x = 0; x < w; x++) {
      const c = grid[y][x];
      if (c === '#') tiles[y][x] = 1;
      else if (c === 'X') { tiles[y][x] = 2; crates[y * w + x] = 40; }
      else { tiles[y][x] = 0; if (c === 'S') spawns.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }); }
    }
  }
  return { name: m.name, w, h, tiles, spawns, crates, pxW: w * TILE, pxH: h * TILE };
}

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      name, players: new Map(), bullets: [], pickups: [], explosions: [],
      mapIdx: 0, map: buildMap(0), nextId: 1,
      phase: 'lobby', killLimit: 20, winner: null,
      pickupTimer: 180,
    });
  }
  return rooms.get(name);
}

function solidAt(map, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return 1;
  const t = map.tiles[ty][tx];
  if (t === 1) return 1;
  if (t === 2 && (map.crates[ty * map.w + tx] || 0) > 0) return 2;
  return 0;
}

function randomSpawn(room) {
  const s = room.map.spawns;
  if (s.length) return { ...s[Math.floor(Math.random() * s.length)] };
  // fallback: random empty tile
  for (let i = 0; i < 200; i++) {
    const x = rnd(TILE, room.map.pxW - TILE), y = rnd(TILE, room.map.pxH - TILE);
    if (!solidAt(room.map, x, y)) return { x, y };
  }
  return { x: room.map.pxW / 2, y: room.map.pxH / 2 };
}
function rnd(a, b) { return a + Math.random() * (b - a); }

// a random drivable (non-wall, non-crate) spot anywhere on the map — for pickups
function randomFloor(room) {
  const m = room.map;
  for (let i = 0; i < 300; i++) {
    const tx = 1 + Math.floor(Math.random() * (m.w - 2));
    const ty = 1 + Math.floor(Math.random() * (m.h - 2));
    if (m.tiles[ty][tx] === 0) {
      const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
      // make sure a tank actually fits here (no wall within its radius)
      if (!circleHitsWall(m, x, y)) return { x, y };
    }
  }
  return randomSpawn(room);
}

function spawnPlayer(room, ws, name, opts = {}) {
  const id = nextPid++;
  const slot = room.players.size;
  const token = crypto.randomBytes(8).toString('hex');
  const sp = randomSpawn(room);
  const p = {
    id, ws, token, name: name || ('Tank ' + id),
    color: opts.color || COLORS[slot % COLORS.length],
    skin: (opts.skin | 0) % 4,
    x: sp.x, y: sp.y, angle: 0, turret: 0,
    hp: 100, maxHp: 100, alive: true, respawnAt: 0,
    weapon: WEAPON_KEYS.includes(opts.weapon) ? opts.weapon : 'cannon', cd: 0,
    shield: 0, speedUntil: 0, dmgUntil: 0,
    kills: 0, deaths: 0,
    input: {}, disconnectedAt: 0,
  };
  room.players.set(id, p);
  return p;
}

function resetMatch(room) {
  room.map = buildMap(room.mapIdx);
  room.bullets = []; room.pickups = []; room.explosions = [];
  room.phase = 'playing'; room.winner = null; room.pickupTimer = 120;
  for (const p of room.players.values()) {
    p.kills = 0; p.deaths = 0; p.hp = p.maxHp; p.alive = true; // keep each tank's chosen weapon
    p.shield = 0; p.speedUntil = 0; p.dmgUntil = 0; p.cd = 0;
    const sp = randomSpawn(room); p.x = sp.x; p.y = sp.y;
  }
}

function moveTank(room, p, dt) {
  const i = p.input;
  const now = Date.now();
  const boost = now < p.speedUntil ? 1.5 : 1;
  const ROT = 2.8, SPD = 165 * boost;
  if (i.left) p.angle -= ROT * dt;
  if (i.right) p.angle += ROT * dt;
  let move = (i.up ? 1 : 0) - (i.down ? 1 : 0);
  if (move) {
    const nx = p.x + Math.cos(p.angle) * SPD * move * dt;
    const ny = p.y + Math.sin(p.angle) * SPD * move * dt;
    // resolve against walls per-axis
    if (!circleHitsWall(room.map, nx, p.y)) p.x = nx;
    if (!circleHitsWall(room.map, p.x, ny)) p.y = ny;
  }
  if (typeof i.aim === 'number') p.turret = i.aim;
}
function circleHitsWall(map, cx, cy) {
  const minx = Math.floor((cx - TANK_R) / TILE), maxx = Math.floor((cx + TANK_R) / TILE);
  const miny = Math.floor((cy - TANK_R) / TILE), maxy = Math.floor((cy + TANK_R) / TILE);
  for (let ty = miny; ty <= maxy; ty++) for (let tx = minx; tx <= maxx; tx++) {
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
    const t = map.tiles[ty][tx];
    const solid = t === 1 || (t === 2 && (map.crates[ty * map.w + tx] || 0) > 0);
    if (!solid) continue;
    const nx = Math.max(tx * TILE, Math.min(cx, tx * TILE + TILE));
    const ny = Math.max(ty * TILE, Math.min(cy, ty * TILE + TILE));
    if ((cx - nx) ** 2 + (cy - ny) ** 2 < TANK_R * TANK_R) return true;
  }
  return false;
}

function fire(room, p) {
  const w = WEAPONS[p.weapon];
  const now = Date.now();
  const dmgBoost = now < p.dmgUntil ? 1.5 : 1;
  const bx = p.x + Math.cos(p.turret) * (TANK_R + 6);
  const by = p.y + Math.sin(p.turret) * (TANK_R + 6);
  for (let n = 0; n < w.pellets; n++) {
    const a = p.turret + (w.spread ? rnd(-w.spread, w.spread) : 0);
    room.bullets.push({
      id: room.nextId++, owner: p.id, x: bx, y: by, angle: a, weapon: p.weapon,
      vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
      dmg: w.dmg * dmgBoost, r: w.r, life: w.life, color: w.color,
      pierceTanks: !!w.pierceTanks, pierceWall: !!w.pierceWall, bounces: w.bounce || 0, hit: [],
    });
  }
  p.muzzle = now;
}

function hurt(room, p, dmg, by) {
  if (!p.alive) return;
  if (p.shield > 0) { const a = Math.min(p.shield, dmg); p.shield -= a; dmg -= a; }
  p.hp -= dmg;
  if (p.hp <= 0) {
    p.alive = false; p.deaths++; p.respawnAt = Date.now() + RESPAWN;
    room.explosions.push({ x: p.x, y: p.y, t: Date.now() });
    const killer = room.players.get(by);
    if (killer && killer !== p) { killer.kills++; room.killfeed = { a: killer.name, b: p.name, w: killer.weapon, t: Date.now() }; }
    if (killer && room.killfeed) broadcast(room, { t: 'kill', ...room.killfeed });
    // win check
    if (killer && killer.kills >= room.killLimit) { room.phase = 'over'; room.winner = killer.name; }
  }
}

function step(room, dt) {
  if (room.phase !== 'playing') return;
  const now = Date.now();
  room.crateBreaks = [];

  // respawns
  for (const p of room.players.values()) {
    if (!p.alive && now >= p.respawnAt) {
      const sp = randomSpawn(room); p.x = sp.x; p.y = sp.y;
      p.hp = p.maxHp; p.alive = true; p.shield = 0;
    }
    if (p.alive) {
      moveTank(room, p, dt);
      p.cd = Math.max(0, p.cd - dt);
      if (p.input.shoot && p.cd <= 0) { fire(room, p); p.cd = WEAPONS[p.weapon].cd; }
    }
  }

  // damage a crate at a tile; returns true if a solid crate was there
  const hitCrate = (px, py, dmg) => {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE), k = ty * room.map.w + tx;
    if (room.map.tiles[ty] && room.map.tiles[ty][tx] === 2 && (room.map.crates[k] || 0) > 0) {
      room.map.crates[k] -= dmg;
      if (room.map.crates[k] <= 0) { room.map.tiles[ty][tx] = 0; room.crateBreaks.push({ x: tx, y: ty }); room.explosions.push({ x: tx * TILE + 20, y: ty * TILE + 20, t: now, small: true }); }
      return true;
    }
    return false;
  };

  // bullets
  for (const b of room.bullets) {
    b.life -= dt;
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    if (b.pierceWall) {
      // railgun: phase straight through walls & crates
      b.x = nx; b.y = ny;
    } else {
      // per-axis collision so bouncing reflects off the correct face
      const sx = solidAt(room.map, nx, b.y);
      if (sx) {
        if (sx === 2) hitCrate(nx, b.y, b.dmg);
        if (b.bounces > 0) { b.vx = -b.vx; b.bounces--; } else b.life = 0;
      } else b.x = nx;
      const sy = solidAt(room.map, b.x, ny);
      if (sy) {
        if (sy === 2) hitCrate(b.x, ny, b.dmg);
        if (b.bounces > 0) { b.vy = -b.vy; b.bounces--; } else b.life = 0;
      } else b.y = ny;
      b.angle = Math.atan2(b.vy, b.vx); // keep shell sprite aligned after bounce
    }
    if (b.life <= 0) continue;
    // tanks
    for (const p of room.players.values()) {
      if (!p.alive || p.id === b.owner || b.hit.includes(p.id)) continue;
      if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 < (b.r + TANK_R) ** 2) {
        hurt(room, p, b.dmg, b.owner); b.hit.push(p.id);
        if (!b.pierceTanks) { b.life = 0; }
        break;
      }
    }
  }
  room.bullets = room.bullets.filter(b => b.life > 0);

  // pickups spawn + collect
  if (--room.pickupTimer <= 0 && room.pickups.length < 5) {
    room.pickupTimer = 240;
    const sp = randomFloor(room);
    room.pickups.push({ id: room.nextId++, x: sp.x, y: sp.y, type: PICKUP_TYPES[Math.floor(Math.random() * PICKUP_TYPES.length)] });
  }
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    for (const pk of room.pickups) {
      if (pk.taken) continue;
      if ((p.x - pk.x) ** 2 + (p.y - pk.y) ** 2 < (TANK_R + 14) ** 2) {
        pk.taken = true;
        if (pk.type === 'health') p.hp = Math.min(p.maxHp, p.hp + 45);
        else if (pk.type === 'shield') p.shield = 60;
        else if (pk.type === 'speed') p.speedUntil = now + 6000;
        else if (pk.type === 'damage') p.dmgUntil = now + 8000;
        p.pickedAt = now; p.pickedType = pk.type;
      }
    }
  }
  room.pickups = room.pickups.filter(pk => !pk.taken);
  room.explosions = room.explosions.filter(e => now - e.t < 600);
}

function serialize(room) {
  const now = Date.now();
  return {
    t: 'state', phase: room.phase, winner: room.winner, killLimit: room.killLimit,
    map: { w: room.map.w, h: room.map.h, name: room.map.name },
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, skin: p.skin,
      x: Math.round(p.x), y: Math.round(p.y), angle: +p.angle.toFixed(2), turret: +p.turret.toFixed(2),
      hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp, alive: p.alive, shield: Math.round(p.shield),
      weapon: p.weapon, kills: p.kills, deaths: p.deaths,
      respawnIn: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - now) / 1000)),
      muzzle: p.muzzle && now - p.muzzle < 70, speed: now < p.speedUntil, dmg: now < p.dmgUntil,
      disconnected: p.disconnectedAt > 0,
    })),
    bullets: room.bullets.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), r: b.r, c: b.color, w: b.weapon, a: +b.angle.toFixed(2) })),
    pickups: room.pickups.map(pk => ({ id: pk.id, x: pk.x, y: pk.y, type: pk.type })),
    explosions: room.explosions.map(e => ({ x: e.x, y: e.y, t: e.t, small: !!e.small })),
    crateBreaks: room.crateBreaks || [],
  };
}
function mapMsg(room) {
  return { t: 'map', mapIdx: room.mapIdx, name: room.map.name, w: room.map.w, h: room.map.h, tile: TILE,
    tiles: room.map.tiles.map(row => row.join('')), };
}
function lobbyMsg(room) {
  return { t: 'lobby', mapIdx: room.mapIdx, killLimit: room.killLimit,
    players: [...room.players.values()].map(p => ({ name: p.name, color: p.color })) };
}
function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
}

// loop
let last = Date.now();
setInterval(() => {
  const now = Date.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) if (p.disconnectedAt && now - p.disconnectedAt > 20000) room.players.delete(p.id);
    step(room, dt);
    if (room.players.size > 0) broadcast(room, serialize(room));
    else rooms.delete(room.name);
  }
}, TICK);

wss.on('connection', (ws) => {
  let room = null, player = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      const rn = (m.room || 'lobby').toString().slice(0, 24);
      room = getRoom(rn);
      if (m.token) for (const p of room.players.values()) if (p.token === m.token) { player = p; break; }
      if (player) { player.ws = ws; player.disconnectedAt = 0; }
      else player = spawnPlayer(room, ws, (m.name || '').toString().slice(0, 16), { color: cleanColor(m.color), skin: +m.skin || 0, weapon: m.weapon });
      ws.send(JSON.stringify({ t: 'joined', id: player.id, token: player.token, room: rn }));
      ws.send(JSON.stringify(mapMsg(room)));
      broadcast(room, lobbyMsg(room));
      return;
    }
    if (!room || !player) return;
    if (m.t === 'input') {
      player.input = {
        up: !!m.up, down: !!m.down, left: !!m.left, right: !!m.right,
        shoot: !!m.shoot, aim: typeof m.aim === 'number' ? m.aim : player.input.aim,
      };
    } else if (m.t === 'weapon' && (room.phase === 'lobby' || room.phase === 'over')) {
      if (WEAPON_KEYS.includes(m.weapon)) player.weapon = m.weapon;
    } else if (m.t === 'map' && (room.phase === 'lobby' || room.phase === 'over')) {
      room.mapIdx = (+m.mapIdx || 0) % MAPS.length; room.map = buildMap(room.mapIdx);
      broadcast(room, lobbyMsg(room)); broadcast(room, mapMsg(room));
    } else if (m.t === 'start') {
      resetMatch(room); broadcast(room, mapMsg(room));
    }
  });
  ws.on('close', () => { if (player) { player.disconnectedAt = Date.now(); player.ws = null; } });
});
function cleanColor(c) { return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : null; }

server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} busy — stop the other server first.`); process.exit(1); } });
server.listen(PORT, () => console.log(`Tank Arena running on http://localhost:${PORT}`));
