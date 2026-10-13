'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const POINTS = [1, 2, 3, 4];
const TRUCO = ['', 'Truco', 'Retruco', 'Vale cuatro'];
const ENV = { E: 'Envido', R: 'Real envido', F: 'Falta envido' };
const ENVPTS = { E: 2, R: 3 };
const FIX = { '1E': 14, '1B': 13, '7E': 12, '7O': 11, '1O': 8, '1C': 8, '7C': 4, '7B': 4 };
const BYNUM = { 3: 10, 2: 9, 12: 7, 11: 6, 10: 5, 6: 3, 5: 2, 4: 1 };
const CARD_RE = /^(1|2|3|4|5|6|7|10|11|12)[EBOC]$/;

/* ---------------- reglas ---------------- */
const rnd = (n) => crypto.randomInt(n);
const power = (c) => (FIX[c] !== undefined ? FIX[c] : BYNUM[parseInt(c, 10)]);

function envidoOf(hand) {
  const val = (c) => { const n = parseInt(c, 10); return n <= 7 ? n : 0; };
  let best = -1;
  for (const s of ['E', 'B', 'O', 'C']) {
    const same = hand.filter((c) => c.slice(-1) === s).map(val).sort((a, b) => b - a);
    if (same.length >= 2) best = Math.max(best, 20 + same[0] + same[1]);
  }
  if (best < 0) best = Math.max(...hand.map(val));
  return best;
}
function newDeck() {
  const d = [];
  for (const s of ['E', 'B', 'O', 'C']) for (const n of [1, 2, 3, 4, 5, 6, 7, 10, 11, 12]) d.push(n + s);
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function dealRound(d, mano) {
  const dk = newDeck(), hands = {}, init = {}, played = {};
  for (let s = 0; s < d.size; s++) { hands[s] = dk.slice(s * 3, s * 3 + 3); init[s] = hands[s].slice(); played[s] = []; }
  d.round = { n: d.round ? d.round.n + 1 : 1, mano, turn: mano, hands, init, played, bazas: [], cur: [], trucoLvl: 0, trucoRight: -1, ask: null, envidoDone: false, envidoRes: null, over: null };
}
function roundWinner(bz, mano) {
  const [a, b, c] = bz;
  if (bz.length >= 2) {
    if (a !== -1 && (b === -1 || a === b)) return a;
    if (a === -1 && b !== -1) return b;
  }
  if (bz.length === 3) {
    if (c !== -1) return c;
    if (a !== -1) return a;
    return mano % 2;
  }
  return null;
}
function addLog(d, seat, t) {
  d.log.push({ s: seat, t, k: Date.now() + ':' + Math.random().toString(36).slice(2, 6) });
  if (d.log.length > 8) d.log = d.log.slice(-8);
}
const nm = (d, s) => (d.seats[s] ? d.seats[s].name : '?');
const teamName = (d, t) => (d.size === 2 ? nm(d, t) : nm(d, t) + ' y ' + nm(d, t + 2));
function checkEnd(d, team) {
  if (d.score[team] >= d.target) { d.status = 'finished'; d.winner = team; addLog(d, -1, 'Ganaron ' + teamName(d, team)); }
}
function finishRound(d, team, pts, why) {
  const r = d.round;
  r.ask = null; r.over = { team, pts, t: why };
  d.score[team] += pts;
  checkEnd(d, team);
}
function playCard(d, seat, card) {
  const r = d.round;
  r.hands[seat] = r.hands[seat].filter((c) => c !== card);
  r.played[seat].push(card);
  r.cur.push({ s: seat, c: card });
  if (r.cur.length < d.size) { r.turn = (seat + 1) % d.size; return; }
  const mx = Math.max(...r.cur.map((x) => power(x.c)));
  const tops = r.cur.filter((x) => power(x.c) === mx);
  const teams = [...new Set(tops.map((x) => x.s % 2))];
  let w, lead;
  if (teams.length > 1) { w = -1; lead = r.mano; } else { w = teams[0]; lead = tops[0].s; }
  r.bazas.push(w); r.cur = []; r.turn = lead;
  const rw = roundWinner(r.bazas, r.mano);
  if (rw !== null) finishRound(d, rw, POINTS[r.trucoLvl], 'ganó la mano');
}
const canTruco = (r, seat) => r.trucoLvl < 3 && (r.trucoRight === -1 || r.trucoRight === seat % 2);
const envOK = (r) => r.bazas.length === 0 && !r.envidoDone && r.trucoLvl === 0;
function envNext(calls) {
  if (!calls.length) return ['E', 'R', 'F'];
  const last = calls[calls.length - 1], ne = calls.filter((k) => k === 'E').length;
  if (last === 'E') return ne < 2 ? ['E', 'R', 'F'] : ['R', 'F'];
  if (last === 'R') return ['F'];
  return [];
}
function envPoints(d, calls, accepted) {
  const falta = Math.max(1, d.target - Math.max(d.score[0], d.score[1]));
  const sum = (cs) => cs.reduce((t, k) => t + (k === 'F' ? falta : ENVPTS[k]), 0);
  if (accepted) return calls.includes('F') ? falta : sum(calls);
  const before = calls.slice(0, -1);
  return before.length ? sum(before) : 1;
}
function envClose(d, w, pts, res) {
  const r = d.round, a = r.ask;
  r.envidoDone = true; r.envidoRes = res;
  d.score[w] += pts;
  r.ask = a.then || null;
  checkEnd(d, w);
  if (d.status === 'finished') { r.ask = null; r.over = { team: w, pts: 0, t: 'cerró la partida con el envido' }; }
}
/* envido de una pareja: el mejor entre sus jugadores (en mano a mano, el único) */
function teamEnvido(d, t) {
  let best = -1;
  for (let s = t; s < d.size; s += 2) best = Math.max(best, envidoOf(d.round.init[s]));
  return best;
}
function mySeatOf(d, uid) {
  for (let s = 0; s < 4; s++) if (d.seats[s] && d.seats[s].uid === uid) return s;
  return null;
}

/* acciones: devuelven false si no son válidas (sin tocar el estado) */
function doPlay(d, uid, card) {
  const r = d.round, m = mySeatOf(d, uid);
  if (!CARD_RE.test(card) || m === null || d.status !== 'playing' || r.over || r.ask || r.turn !== m || !r.hands[m].includes(card)) return false;
  playCard(d, m, card);
}
function doCallTruco(d, uid) {
  const r = d.round, m = mySeatOf(d, uid);
  if (m === null || d.status !== 'playing' || r.over || r.ask || r.turn !== m || !canTruco(r, m)) return false;
  const lvl = r.trucoLvl + 1;
  r.ask = { kind: 'truco', lvl, by: m };
  addLog(d, m, '¡' + TRUCO[lvl] + '!');
}
function doCallEnvido(d, uid, k) {
  const r = d.round, m = mySeatOf(d, uid);
  if (m === null || d.status !== 'playing' || r.over || r.ask || r.turn !== m || !envOK(r) || !envNext([]).includes(k)) return false;
  r.ask = { kind: 'envido', calls: [k], by: m, then: null };
  addLog(d, m, ENV[k]);
}
function doMazo(d, uid) {
  const r = d.round, m = mySeatOf(d, uid);
  if (m === null || d.status !== 'playing' || r.over || r.ask || r.turn !== m) return false;
  addLog(d, m, 'Me voy al mazo');
  finishRound(d, 1 - (m % 2), POINTS[r.trucoLvl], 'se fue al mazo ' + nm(d, m));
}
function doRespond(d, uid, resp) {
  const r = d.round, m = mySeatOf(d, uid), a = r.ask;
  if (m === null || d.status !== 'playing' || r.over || !a || m % 2 === a.by % 2) return false;
  if (a.kind === 'truco') {
    if (resp === 'quiero') {
      r.trucoLvl = a.lvl; r.trucoRight = m % 2; r.ask = null;
      addLog(d, m, 'Quiero');
    } else if (resp === 'no') {
      addLog(d, m, 'No quiero');
      finishRound(d, a.by % 2, POINTS[a.lvl - 1], nm(d, m) + ' no quiso el ' + TRUCO[a.lvl]);
    } else if (resp === 'up') {
      if (a.lvl >= 3) return false;
      r.trucoLvl = a.lvl;
      r.ask = { kind: 'truco', lvl: a.lvl + 1, by: m };
      addLog(d, m, '¡' + TRUCO[a.lvl + 1] + '!');
    } else if (resp.startsWith('env:')) {
      const k = resp.slice(4);
      if (!(a.lvl === 1 && envOK(r)) || !envNext([]).includes(k)) return false;
      r.ask = { kind: 'envido', calls: [k], by: m, then: a };
      addLog(d, m, ENV[k]);
    } else return false;
  } else {
    if (resp === 'quiero') {
      const pts = envPoints(d, a.calls, true);
      const e0 = teamEnvido(d, 0), e1 = teamEnvido(d, 1);
      const w = e0 > e1 ? 0 : e1 > e0 ? 1 : r.mano % 2;
      addLog(d, m, 'Quiero');
      addLog(d, -1, 'Envido: ' + e0 + ' contra ' + e1 + '. +' + pts + ' para ' + teamName(d, w));
      envClose(d, w, pts, { e: [e0, e1], w, pts, q: true });
    } else if (resp === 'no') {
      const p2 = envPoints(d, a.calls, false);
      addLog(d, m, 'No quiero');
      envClose(d, a.by % 2, p2, { w: a.by % 2, pts: p2, q: false });
    } else if (resp.startsWith('env:')) {
      const k2 = resp.slice(4);
      if (!envNext(a.calls).includes(k2)) return false;
      r.ask = { kind: 'envido', calls: a.calls.concat([k2]), by: m, then: a.then };
      addLog(d, m, ENV[k2]);
    } else return false;
  }
}
function doNext(d, uid) {
  if (mySeatOf(d, uid) === null || d.status !== 'playing' || !d.round.over) return false;
  dealRound(d, (d.round.mano + 1) % d.size);
  addLog(d, -1, 'Nueva mano');
}
function doRematch(d, uid) {
  if (mySeatOf(d, uid) === null || d.status !== 'finished') return false;
  d.score = { 0: 0, 1: 0 }; d.status = 'playing'; d.winner = null;
  dealRound(d, (d.round.mano + 1) % d.size);
  addLog(d, -1, 'Revancha');
}
function applyAct(d, uid, a) {
  if (typeof a !== 'string' || a.length > 12) return false;
  if (a.startsWith('play:')) return doPlay(d, uid, a.slice(5));
  if (a === 'truco') return doCallTruco(d, uid);
  if (a.startsWith('call:')) return doCallEnvido(d, uid, a.slice(5));
  if (a === 'mazo') return doMazo(d, uid);
  if (a === 'quiero' || a === 'no' || a === 'up' || a.startsWith('env:')) return doRespond(d, uid, a);
  if (a === 'next') return doNext(d, uid);
  if (a === 'rematch') return doRematch(d, uid);
  return false;
}

/* ---------------- mesas ---------------- */
const rooms = new Map();
function genCode() {
  const c = 'BCDFGHJKLMNPRSTVXZ23456789';
  for (;;) {
    let o = '';
    for (let i = 0; i < 4; i++) o += c[rnd(c.length)];
    if (!rooms.has(o)) return o;
  }
}
function newRoom(code) {
  return { d: { code, status: 'lobby', size: 4, target: 30, seats: {}, score: { 0: 0, 1: 0 }, log: [], round: null, winner: null }, clients: new Set(), last: Date.now() };
}
/* lo que ve cada jugador: sus cartas sí, las de los demás solo la cantidad */
function view(room, uid) {
  const d = JSON.parse(JSON.stringify(room.d));
  const mine = mySeatOf(room.d, uid);
  const online = new Set([...room.clients].map((c) => c.uid));
  for (const s of Object.keys(d.seats)) d.seats[s] = { name: d.seats[s].name, on: online.has(room.d.seats[s].uid) };
  if (d.round) {
    delete d.round.init;
    for (let s = 0; s < d.size; s++) if (s !== mine) d.round.hands[s] = d.round.hands[s].map(() => 0);
  }
  return { d, mine };
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(INDEX); return;
  }
  res.writeHead(404); res.end('No encontrado');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const fail = (ws, m, gone) => send(ws, { t: 'err', m, gone: !!gone });
const clean = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
function push(room) {
  for (const c of room.clients) { const v = view(room, c.uid); send(c, { t: 'state', code: room.d.code, d: v.d, mine: v.mine }); }
}
function enter(ws, room) {
  const old = ws.room;
  if (old && old !== room) { old.clients.delete(ws); push(old); }
  ws.room = room; room.clients.add(ws); room.last = Date.now();
  push(room);
}

wss.on('connection', (ws) => {
  ws.uid = null; ws.name = ''; ws.room = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { const r = ws.room; if (r) { r.clients.delete(ws); push(r); } });
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') { ws.uid = clean(m.uid, 60); ws.name = clean(m.name, 14); return; }
    if (!ws.uid) return fail(ws, 'Recargá la página');
    if (m.t === 'create') {
      if (rooms.size >= 1000) return fail(ws, 'Hay demasiadas mesas abiertas, probá más tarde');
      const room = newRoom(genCode()); rooms.set(room.d.code, room); return enter(ws, room);
    }
    if (m.t === 'join') {
      const code = clean(m.code, 4).toUpperCase(), room = rooms.get(code);
      if (!room) return fail(ws, 'No existe la mesa ' + code, true);
      return enter(ws, room);
    }
    const room = ws.room;
    if (!room) return;
    const d = room.d; room.last = Date.now();
    const mine = mySeatOf(d, ws.uid);
    if (m.t === 'sit') {
      const s = Number(m.s);
      if (d.status !== 'lobby' || !Number.isInteger(s) || s < 0 || s >= d.size) return;
      if (!ws.name) return fail(ws, 'Poné tu nombre primero');
      if (d.seats[s] && d.seats[s].uid !== ws.uid) return fail(ws, 'Ese lugar ya está ocupado');
      if (mine !== null) delete d.seats[mine];
      d.seats[s] = { uid: ws.uid, name: ws.name };
    } else if (m.t === 'stand') {
      if (d.status !== 'lobby' || mine === null) return;
      delete d.seats[mine];
    } else if (m.t === 'size') {
      if (d.status !== 'lobby' || (m.n !== 2 && m.n !== 4)) return;
      d.size = m.n;
      /* al pasar a mano a mano, los sentados en 2 y 3 se mueven a los lugares libres (si no hay, quedan parados) */
      for (const s of [2, 3]) {
        if (d.size === 4 || !d.seats[s]) continue;
        const free = [0, 1].find((x) => !d.seats[x]);
        if (free !== undefined) d.seats[free] = d.seats[s];
        delete d.seats[s];
      }
    } else if (m.t === 'target') {
      if (d.status !== 'lobby' || (m.n !== 15 && m.n !== 30)) return;
      d.target = m.n;
    } else if (m.t === 'start') {
      if (d.status !== 'lobby' || mine === null || Object.keys(d.seats).length < d.size) return;
      d.status = 'playing'; d.score = { 0: 0, 1: 0 }; d.winner = null; d.log = [];
      dealRound(d, 0);
      addLog(d, -1, 'Se reparten las cartas');
    } else if (m.t === 'act') {
      if (!d.round || applyAct(d, ws.uid, m.a) === false) return fail(ws, 'Esa jugada ya no está disponible');
    } else return;
    push(room);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, room] of rooms) if (room.clients.size === 0 && now - room.last > 12 * 3600 * 1000) rooms.delete(code);
}, 30000);

server.listen(PORT, () => console.log('Truco escuchando en el puerto ' + PORT));
