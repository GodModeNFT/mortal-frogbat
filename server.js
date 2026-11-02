// Mortal Frogbat — game server
// Serves the Mini App, runs 1v1 rooms (2 fighters, everyone else spectates) and relays inputs in lockstep.
// Both players and all spectators run the same deterministic simulation from the same seed + input stream,
// so every viewer sees the exact same fight and the exact same randomly chosen frogtality.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { startBot } from './bot.js';

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOW_GUESTS = process.env.ALLOW_GUESTS === '1'; // lets you test in a normal browser without Telegram

// ---------- player stats (leaderboard) ----------
// Saved as JSON in DATA_DIR (the installer sets /var/lib/frogbat), keyed by Telegram user id.
const DATA_DIR = process.env.DATA_DIR || new URL('./data/', import.meta.url).pathname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { stats = {}; }
let saveTimer = null;
function writeStats() {
  clearTimeout(saveTimer); saveTimer = null;
  try { fs.writeFileSync(STATS_FILE + '.tmp', JSON.stringify(stats)); fs.renameSync(STATS_FILE + '.tmp', STATS_FILE); }
  catch (e) { console.error('could not save stats', e.message); }
}
function saveStats() { clearTimeout(saveTimer); saveTimer = setTimeout(writeStats, 300); }
// never lose the last match on a restart or update
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (saveTimer) writeStats(); process.exit(0); });
process.on('exit', () => { if (saveTimer) writeStats(); });
// ---------- profile photos ----------
// Fetched through the bot (getUserProfilePhotos) and cached in DATA_DIR/avatars.
// Pages get an opaque key, never the Telegram id or the bot token.
const AV_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AV_DIR, { recursive: true });
const avKey = id => crypto.createHmac('sha256', BOT_TOKEN || 'dev').update(String(id)).digest('hex').slice(0, 20);
const avIds = new Map();      // key -> telegram id
const avNone = new Map();     // key -> time we last found no photo
const avBusy = new Map();     // key -> in-flight fetch
for (const id of Object.keys(stats)) avIds.set(avKey(id), id);
const avatarUrl = user => (user && !String(user.id).startsWith('guest:') ? `/avatar/${avKey(user.id)}` : null);
async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}?${new URLSearchParams(params)}`);
  const j = await r.json(); if (!j.ok) throw new Error(j.description || method); return j.result;
}
async function fetchAvatar(key) {
  const id = avIds.get(key); if (!id || !BOT_TOKEN) return null;
  const file = path.join(AV_DIR, key + '.jpg');
  try { if (Date.now() - fs.statSync(file).mtimeMs < 24 * 3600e3) return file; } catch {}
  if (Date.now() - (avNone.get(key) || 0) < 6 * 3600e3) return fs.existsSync(file) ? file : null;
  if (avBusy.has(key)) return avBusy.get(key);
  const job = (async () => {
    try {
      const res = await tg('getUserProfilePhotos', { user_id: id, limit: 1 });
      if (!res.total_count) { avNone.set(key, Date.now()); return null; }
      const sizes = res.photos[0];
      const pick = sizes.find(s => s.width >= 160) || sizes[sizes.length - 1];
      const f = await tg('getFile', { file_id: pick.file_id });
      const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
      if (!img.ok) throw new Error('download failed');
      fs.writeFileSync(file + '.tmp', Buffer.from(await img.arrayBuffer())); fs.renameSync(file + '.tmp', file);
      return file;
    } catch (e) { avNone.set(key, Date.now()); return fs.existsSync(file) ? file : null; }
    finally { avBusy.delete(key); }
  })();
  avBusy.set(key, job); return job;
}
function rememberUser(user) {
  if (!user || String(user.id).startsWith('guest:')) return;
  const key = avKey(user.id); avIds.set(key, String(user.id)); fetchAvatar(key).catch(() => {}); // warm the cache before the fight starts
}

// ---------- skins ----------
// Each fighter has 7 skins. Skin N unlocks after SKIN_REQ[N] wins *as that fighter* (Kiki = frog, Riri = toad).
const SKIN_REQ = [0, 3, 9, 15, 26, 32, 50, 100];
const SKIN_NAMES = {
  frog: ['Classic', 'Lime Squeeze', 'Poison Dart', 'Bandana Bandit', 'Glass Frog', 'Shadow Ninja', 'Inferno', 'Golden God'],
  toad: ['Classic', 'Mud Puddle', 'Fire-Belly', 'Swamp Brute', 'Toxic Waste', 'Bone Armor', 'Frost Titan', 'Cosmic Overlord'] };
const SIDE_CH = ['frog', 'toad'], FIGHTER_OF = { frog: 'Kiki', toad: 'Riri' };
const MIN_FORFEIT_FRAMES = 20 * 60; // a forfeit only counts toward skins if the fight lasted 20+ seconds (stops win farming)

function playerRow(user) {
  const p = stats[user.id] || (stats[user.id] = { wins: 0, losses: 0, fatalities: 0 });
  p.username = user.username || null; p.first = user.first || ''; p.last = Date.now();
  p.charWins = p.charWins || { frog: 0, toad: 0 };
  p.skin = p.skin || { frog: 0, toad: 0 };
  return p;
}
function equippedSkin(user, ch) {
  const p = user && stats[user.id]; if (!p || !p.skin) return 0;
  const id = p.skin[ch] | 0;
  return id >= 0 && id < SKIN_REQ.length && ((p.charWins && p.charWins[ch]) | 0) >= SKIN_REQ[id] ? id : 0;
}
function profile(user) {
  const p = playerRow(user), lb = leaderboard(user.id);
  return { name: user.name, avatar: avatarUrl(user), wins: p.wins, losses: p.losses, fatalities: p.fatalities,
    rank: lb.you ? lb.you.rank : null, total: lb.total,
    charWins: p.charWins, skin: { frog: equippedSkin(user, 'frog'), toad: equippedSkin(user, 'toad') }, req: SKIN_REQ };
}
// called exactly once per finished match
// returns the skin the winner just unlocked, if any
function recordMatch(r, winnerSide, fatal, countsForSkins = true) {
  if (r.recorded || !r.users) return null; r.recorded = true;
  const w = r.users[winnerSide], l = r.users[1 - winnerSide];
  if (!w || !l || w.id === l.id) return null;
  const pw = playerRow(w), pl = playerRow(l);
  pw.wins++; pl.losses++; if (fatal) pw.fatalities++;
  let unlock = null;
  if (countsForSkins) {
    const ch = SIDE_CH[winnerSide];
    pw.charWins[ch]++;
    const id = SKIN_REQ.indexOf(pw.charWins[ch]);
    if (id > 0) unlock = { side: winnerSide, char: ch, id, name: SKIN_NAMES[ch][id] };
  }
  saveStats();
  if (unlock) broadcast(r, { t: 'unlock', ...unlock });
  return unlock;
}
// e.g. "🎨 @aiman just unlocked a new skin: Lime Squeeze! Won 3 matches with Kiki."
const unlockLine = (r, u, nm) => u
  ? `\n🎨 <b>${esc(nm[u.side] || FIGHTER_OF[u.char])}</b> just unlocked a new skin: <b>${u.name}</b>! Won ${SKIN_REQ[u.id]} matches with ${FIGHTER_OF[u.char]}.`
  : '';
function leaderboard(meId) {
  const rows = Object.entries(stats).map(([id, p]) => ({ id, ...p, games: p.wins + p.losses }))
    .filter(p => p.games > 0)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.fatalities - a.fatalities || b.last - a.last);
  const pub = (p, i) => ({ rank: i + 1, username: p.username, name: p.first, wins: p.wins, losses: p.losses, fatalities: p.fatalities,
    avatar: String(p.id).startsWith('guest:') ? null : `/avatar/${avKey(p.id)}` });
  const meIdx = meId == null ? -1 : rows.findIndex(p => String(p.id) === String(meId));
  return { players: rows.slice(0, 100).map(pub), you: meIdx >= 0 ? pub(rows[meIdx], meIdx) : null, total: rows.length };
}

const MUSIC_DIR = new URL('./public/music/', import.meta.url).pathname;
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---------- static page ----------
const raw = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const page = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">' +
  '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
  '<script>window.FROG_ONLINE=true</script></head><body>' + raw + '</body></html>';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(page);
  }
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  // your own skin progress
  if (url.pathname === '/me') {
    const me = whoIsAsking(req);
    if (!me) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"open the game from Telegram"}'); }
    rememberUser(me);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(profile(me)));
  }
  // equip a skin you have unlocked
  if (url.pathname === '/skin' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      const me = whoIsAsking(req);
      let m = {}; try { m = JSON.parse(body); } catch {}
      const ch = m.char === 'toad' ? 'toad' : m.char === 'frog' ? 'frog' : null, id = m.id | 0;
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!me) return json(401, { error: 'open the game from Telegram' });
      if (!ch || id < 0 || id >= SKIN_REQ.length) return json(400, { error: 'unknown skin' });
      const p = playerRow(me);
      if ((p.charWins[ch] | 0) < SKIN_REQ[id]) return json(403, { error: `win ${SKIN_REQ[id]} times as ${FIGHTER_OF[ch]} to unlock this skin` });
      p.skin[ch] = id; saveStats();
      return json(200, profile(me));
    });
    return;
  }
  // map music: files in public/music/ (mp3, ogg, m4a, wav)
  const mus = url.pathname.match(/^\/music\/([A-Za-z0-9 _.-]+\.(mp3|ogg|m4a|wav))$/i);
  if (mus) {
    const file = path.join(MUSIC_DIR, decodeURIComponent(mus[1]));
    if (!file.startsWith(MUSIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const types = { mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' };
    res.writeHead(200, { 'content-type': types[mus[2].toLowerCase()], 'cache-control': 'public, max-age=86400', 'content-length': fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }
  const av = url.pathname.match(/^\/avatar\/([a-f0-9]{20})$/);
  if (av) {
    fetchAvatar(av[1]).then(file => {
      if (!file) { res.writeHead(404, { 'cache-control': 'max-age=600' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600' });
      fs.createReadStream(file).pipe(res);
    }).catch(() => { res.writeHead(404); res.end(); });
    return;
  }
  // the profile page's Fight section: what's happening in the group, and starting a game from the profile
  const ck = url.pathname.match(/^\/chat\/([a-f0-9]{12})(\/start)?$/);
  if (ck) {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    const me = whoIsAsking(req), chatId = chatFromKey(ck[1]);
    if (!me) return json(401, { error: 'open the game from Telegram' });
    if (chatId == null) return json(404, { error: 'unknown group' });
    if (!ck[2]) return json(200, chatStatus(chatId));
    if (req.method !== 'POST') return json(405, { error: 'use POST' });
    (async () => {
      if (bot && !(await bot.isMember(chatId, me.id))) return json(403, { error: 'join the group first' });
      const st = chatStatus(chatId);
      if (st.state !== 'none') return json(200, st);       // someone beat you to it: join or watch that one
      const r = openRoom(chatId);
      if (bot) bot.postLobby(chatId, r.id, me.name);       // the normal /duke post, so the whole group sees it
      return json(200, { state: 'open', room: r.id, names: ['', ''], picker: null, started: true });
    })().catch(e => json(500, { error: e.message }));
    return;
  }
  if (url.pathname === '/leaderboard') {
    const me = whoIsAsking(req);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(leaderboard(me ? me.id : null)));
  }
  res.writeHead(404); res.end('not found');
});

function whoIsAsking(req) {
  const init = String(req.headers['x-init-data'] || '');
  return checkInitData(init) || (ALLOW_GUESTS && req.headers['x-guest'] ? guestUser(String(req.headers['x-guest'])) : null);
}
const guestUser = n => ({ id: 'guest:' + n.slice(0, 20), username: n.slice(0, 20), first: '', name: n.slice(0, 20) });

// ---------- Telegram initData check ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function checkInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null; // older than a day
  try {
    const u = JSON.parse(params.get('user') || '{}');
    if (!u.id) return null;
    return { id: u.id, username: u.username || null, first: String(u.first_name || '').slice(0, 32), name: (u.username ? '@' + u.username : u.first_name || 'Frog').slice(0, 20) };
  }
  catch { return null; }
}

// ---------- rooms ----------
// One pit per chat. /duke opens it; while it's waiting or live, /duke just reposts the same pit.
// Each pit holds exactly one match. When it ends (win or forfeit) the pit closes and /duke opens a new one.
const rooms = new Map();
const chatRooms = new Map(); // chatId -> roomId
const FATAL_NAMES = new Set(['SPINE SNATCH', 'ACID BATH', 'BLOAT', 'LILY PAD SPLAT', 'SWALLOWED WHOLE', 'HEAD HOP']);
const FIGHTERS = ['Kiki', 'Riri'];
const STALE_MS = 20 * 60e3; // an untouched waiting pit is replaced after 20 minutes

function newRoom(id, chatId = null) {
  return { id, chatId, state: 'open', players: [null, null], specs: new Set(), seed: 0, frames: [], pend: [new Map(), new Map()],
    next: 0, results: [null, null], announced: false, timer: null, lastActive: Date.now() };
}
// ---------- group chats ----------
// Profile links carry an opaque key for the group they came from, so the profile can show that group's lobby.
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
let chats = {};
try { chats = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch { chats = {}; }
export function chatKey(chatId) {
  const k = crypto.createHmac('sha256', (BOT_TOKEN || 'dev') + ':chat').update(String(chatId)).digest('hex').slice(0, 12);
  if (chats[k] !== String(chatId)) {
    chats[k] = String(chatId);
    try { fs.writeFileSync(CHATS_FILE + '.tmp', JSON.stringify(chats)); fs.renameSync(CHATS_FILE + '.tmp', CHATS_FILE); } catch (e) { console.error('could not save chats', e.message); }
  }
  return k;
}
const chatFromKey = k => (chats[k] != null ? (/^-?\d+$/.test(chats[k]) ? Number(chats[k]) : chats[k]) : null);
function chatStatus(chatId) {
  const cur = rooms.get(chatRooms.get(chatId));
  if (!cur || cur.state === 'done') return { state: 'none' };
  if (cur.state === 'open' && !everyone(cur).length && Date.now() - cur.lastActive > STALE_MS) return { state: 'none' };
  return { state: cur.state, room: cur.id, names: cur.state === 'live' ? cur.names : names(cur), picker: cur.picker && cur.picker.user ? cur.picker.user.name : null };
}

export function openRoom(chatId) {
  const cur = rooms.get(chatRooms.get(chatId));
  if (cur && cur.state !== 'done') {
    const stale = cur.state === 'open' && !everyone(cur).length && Date.now() - cur.lastActive > STALE_MS;
    if (!stale) return { id: cur.id, existing: true, state: cur.state, names: names(cur), picker: cur.picker && cur.picker.user ? cur.picker.user.name : null };
    rooms.delete(cur.id);
  }
  let id;
  do { id = crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6); } while (rooms.has(id));
  rooms.set(id, newRoom(id, chatId)); chatRooms.set(chatId, id);
  return { id, existing: false, state: 'open', names: ['', ''] };
}
function findRoom(id) {
  if (!rooms.has(id) && ALLOW_GUESTS) rooms.set(id, newRoom(id)); // local testing without the bot
  return rooms.get(id) || null;
}
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
const everyone = r => [...r.players.filter(Boolean), ...(r.picker ? [r.picker] : []), ...r.specs];
const broadcast = (r, m) => { const s = JSON.stringify(m); for (const ws of everyone(r)) send(ws, s); };
const names = r => r.players.map(p => (p ? p.user.name : ''));
const roleOf = (r, ws) => (r.players[0] === ws ? 'p1' : r.players[1] === ws ? 'p2' : 'spec');
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const who = (r, s, nm) => `<b>${esc(nm[s] || FIGHTERS[s])}</b> (${FIGHTERS[s]})`;
const CLOSED = 'This fight is over. Type /duke in the chat to open a new pit.';

function startMatch(r) {
  r.state = 'live'; r.seed = crypto.randomInt(1, 2 ** 31 - 1); r.frames = []; r.pend = [new Map(), new Map()]; r.next = 0;
  r.results = [null, null]; r.names = names(r); r.users = r.players.map(p => p.user); r.avatars = r.users.map(avatarUrl); r.skins = r.users.map((u, i) => equippedSkin(u, SIDE_CH[i])); r.recorded = false;
  for (const ws of everyone(r)) send(ws, { t: 'start', seed: r.seed, names: r.names, avatars: r.avatars, skins: r.skins, role: roleOf(r, ws) });
}
// The first fighter into an empty pit picks Kiki or Riri; the next fighter gets the other one.
const PICK_MS = Number(process.env.PICK_MS || 30_000); // no choice within 30 s = Kiki
function askToPick(r, ws) {
  r.picker = ws; send(ws, { t: 'pick' });
  clearTimeout(r.pickTimer); r.pickTimer = setTimeout(() => { if (r.picker === ws) takePick(r, ws, 'frog'); }, PICK_MS);
}
function takePick(r, ws, ch) {
  if (r.picker !== ws || r.state !== 'open') return;
  clearTimeout(r.pickTimer); r.picker = null;
  const slot = ch === 'toad' ? 1 : 0;
  r.specs.delete(ws); r.players[slot] = ws; send(ws, { t: 'role', role: slot ? 'p2' : 'p1' });
  fillSlots(r);
}
function fillSlots(r) {
  if (r.state !== 'open') return;
  const waiting = () => [...r.specs].find(w => !w.wantSpec);
  if (!r.players[0] && !r.players[1]) {
    // empty pit: the first fighter in line chooses a side
    if (!r.picker && waiting()) { const ws = waiting(); r.specs.delete(ws); askToPick(r, ws); }
  } else {
    for (let s = 0; s < 2; s++) {
      const next = waiting();
      if (!r.players[s] && next) { r.specs.delete(next); r.players[s] = next; send(next, { t: 'role', role: s ? 'p2' : 'p1' }); }
    }
  }
  if (r.players[0] && r.players[1]) return startMatch(r);
  const pickerName = r.picker && r.picker.user ? r.picker.user.name : 'The first fighter';
  const half = r.players[0] ? 'Kiki' : r.players[1] ? 'Riri' : null;
  for (const ws of everyone(r)) {
    if (ws === r.picker) continue;
    send(ws, { t: 'wait', msg: r.picker ? `${pickerName} is choosing a fighter…` : half ? `${half} is waiting for an opponent…` : 'Waiting for fighters…' });
  }
}

function onInput(r, ws, m) {
  const s = r.players.indexOf(ws);
  if (s < 0 || r.state !== 'live') return;
  const f = m.f | 0, b = (m.b | 0) & 511;
  if (f < r.next || f > r.next + 240) return;
  r.pend[s].set(f, b);
  while (r.pend[0].has(r.next) && r.pend[1].has(r.next)) {
    const a = r.pend[0].get(r.next), c = r.pend[1].get(r.next);
    r.pend[0].delete(r.next); r.pend[1].delete(r.next);
    r.frames.push([a, c]);
    broadcast(r, { t: 'fr', f: r.next, a, b: c });
    r.next++;
  }
  r.lastActive = Date.now();
}

let bot = null;
function announce(r, html) {
  if (r.announced) return; r.announced = true;
  if (bot && r.chatId) bot.announce(r.chatId, html + '\nType /duke to open a new pit.');
}
function announceResult(r, json) {
  const res = JSON.parse(json), nm = r.names || names(r);
  const u = recordMatch(r, res.w, res.method === 'fatality');
  announce(r, (res.method === 'fatality'
    ? `🩸 <b>FROGTALITY!</b> ${who(r, res.w, nm)} finished ${who(r, 1 - res.w, nm)} with <b>${res.fatal}</b>.`
    : `🐸 ${who(r, res.w, nm)} beat ${who(r, 1 - res.w, nm)}. No frogtality, merciful frog.`) + unlockLine(r, u, nm));
}
function onResult(r, ws, m) {
  const s = r.players.indexOf(ws);
  if (s < 0 || r.announced) return;
  r.results[s] = JSON.stringify({ w: m.winner ? 1 : 0, method: m.method === 'fatality' ? 'fatality' : 'ko', fatal: FATAL_NAMES.has(m.fatal) ? m.fatal : null });
  r.state = 'done'; // match is over, the pit is closed
  if (r.results[0] && r.results[0] === r.results[1]) { clearTimeout(r.timer); announceResult(r, r.results[0]); }
  else if (!r.timer) r.timer = setTimeout(() => { const j = r.results[0] || r.results[1]; if (j) announceResult(r, j); }, 5000);
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  let room = null;
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'join' && !room) {
      const user = checkInitData(m.initData) || (ALLOW_GUESTS ? guestUser(String(m.name || 'Guest')) : null);
      if (!user) { send(ws, { t: 'closed', msg: 'Open the game from the Telegram chat to play.' }); return ws.close(); }
      ws.user = user; ws.wantSpec = !!m.spec; rememberUser(user);
      const r = findRoom(String(m.room || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32));
      if (!r) { send(ws, { t: 'closed', msg: 'No pit here. Type /duke in the chat to open one.' }); return ws.close(); }
      if (r.state === 'done') { send(ws, { t: 'closed', msg: CLOSED }); return ws.close(); }
      room = r; room.lastActive = Date.now();
      // fighters queue as specs; fillSlots hands out the pick / the remaining slot. Spectate links never take a slot.
      room.specs.add(ws);
      if (room.state === 'live' || m.spec) send(ws, { t: 'role', role: 'spec' });
      if (room.state === 'live') send(ws, { t: 'sync', seed: room.seed, names: room.names, avatars: room.avatars, skins: room.skins, role: 'spec', frames: room.frames });
      fillSlots(room);
    } else if (room) {
      if (m.t === 'in') onInput(room, ws, m);
      else if (m.t === 'result') onResult(room, ws, m);
      else if (m.t === 'pick') takePick(room, ws, m.char === 'toad' ? 'toad' : 'frog');
    }
  });
  ws.on('close', () => {
    if (!room) return;
    if (room.picker === ws) { clearTimeout(room.pickTimer); room.picker = null; fillSlots(room); return; }
    const s = room.players.indexOf(ws);
    if (s < 0) { room.specs.delete(ws); return; }
    if (room.state === 'live') {
      // forfeit: the one who stayed wins and the pit closes
      room.state = 'done';
      const nm = room.names || names(room);
      broadcast(room, { t: 'left', msg: `${nm[s] || FIGHTERS[s]} fled the pit. ${nm[1 - s] || FIGHTERS[1 - s]} wins by forfeit. Type /duke in the chat for a new game.` });
      const u = recordMatch(room, 1 - s, false, room.frames.length >= MIN_FORFEIT_FRAMES);
      announce(room, `🏃 ${who(room, s, nm)} fled the pit. ${who(room, 1 - s, nm)} wins by forfeit.` + unlockLine(room, u, nm));
      room.players[s] = null;
    } else {
      room.players[s] = null;
      fillSlots(room);
    }
  });
});

// clean up finished or abandoned pits
setInterval(() => {
  for (const [id, r] of rooms) if (!everyone(r).length && (r.state === 'done' || Date.now() - r.lastActive > 60 * 60e3)) {
    rooms.delete(id); if (chatRooms.get(r.chatId) === id && r.state !== 'done') chatRooms.delete(r.chatId);
  }
}, 60e3);

server.listen(PORT, () => {
  console.log(`Mortal Frogbat listening on :${PORT}`);
  if (BOT_TOKEN && process.env.BOT_USERNAME && process.env.APP_SHORT_NAME) {
    bot = startBot({ token: BOT_TOKEN, username: process.env.BOT_USERNAME, appShort: process.env.APP_SHORT_NAME, openRoom, chatKey });
  } else console.log('Bot not started (set BOT_TOKEN, BOT_USERNAME, APP_SHORT_NAME).');
});
