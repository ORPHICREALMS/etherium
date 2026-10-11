// ============================================================================
//  0.2.05 MULTIPLAYER — THE RELAY.  This file knows nothing about the game itself.  It keeps rooms, slots and the turn clock, and passes
//  every player's commands to everybody in numbered turns ("bundles").  Every player's browser runs the whole game and applies the same
//  bundles in the same order, so everybody plays the exact same game.  It also keeps a snapshot and a short log so a player who closed
//  the tab or lost the connection can come back and catch up.  The same code runs inside the Node server (server/server.js) and inside
//  the game page for the solo "Test Lobby" (a pretend network with a delay), so the page and the server cannot disagree.
//
//  env = { send(cid, msg), now(), setTimer(fn, ms) -> id, clearTimer(id), rand() }
// ============================================================================
const MP_SLOTS = 4, MP_MS = 100, MP_SNAP_EVERY = 600, MP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MP_CFG_DEFAULT = { size: 128, layout: 'continents', theme: 'blended', victory: 'conquest', timeLimit: 30, resLevel: 'normal', startRes: 'standard', startAge: 0, popLimit: 200, speed: 1.5, seed: 0 };
class MPHub {
  constructor(env) { this.env = env; this.rooms = new Map(); this.clients = new Map(); this.toks = new Map(); }
  // ---------------- helpers ----------------
  tx(cid, m) { if (cid != null) this.env.send(cid, m); }
  newCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += MP_CODE_CHARS[Math.floor(this.env.rand() * MP_CODE_CHARS.length)]; } while (this.rooms.has(c)); return c; }
  newTok() { let t = ''; for (let i = 0; i < 20; i++) t += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(this.env.rand() * 36)]; return t; }
  clean(s, n) { return String(s == null ? '' : s).replace(/[<>&"]/g, '').slice(0, n); }
  roomOf(c) { return c && c.code ? this.rooms.get(c.code) : null; }
  slotOf(room, c) { return room && c ? room.slots.findIndex(s => s.tok && s.tok === c.tok) : -1; }
  view(room) {
    return { code: room.code, state: room.state, host: room.slots.findIndex(s => s.tok === room.hostTok), cfg: room.cfg,
      slots: room.slots.map(s => ({ kind: s.kind, name: s.name, race: s.race, diff: s.diff, ready: s.ready, connected: s.kind === 'human' ? !!s.cid : true })) };
  }
  sendRoom(room) { for (let i = 0; i < room.slots.length; i++) { const s = room.slots[i]; if (s.kind === 'human' && s.cid != null) this.tx(s.cid, { t: 'room', room: this.view(room), you: i }); } }
  sendPresence(room) {
    if (room.state !== 'playing') return;
    const pl = room.players.map((sl, pid) => ({ pid, name: room.slots[sl].name, online: room.slots[sl].kind === 'human' ? !!room.slots[sl].cid : true, ai: room.slots[sl].kind === 'ai' }));
    this.broadcast(room, { t: 'pl', pl });
  }
  broadcast(room, m) { for (const s of room.slots) if (s.kind === 'human' && s.cid != null) this.tx(s.cid, m); }
  // ---------------- connections ----------------
  connect(cid) { this.clients.set(cid, { cid, tok: null, name: 'Player', code: null }); }
  disconnect(cid) {
    const c = this.clients.get(cid); if (!c) return; this.clients.delete(cid);
    const room = this.roomOf(c); if (!room) return;
    const i = this.slotOf(room, c);
    if (i >= 0 && room.slots[i].cid === cid) {
      room.slots[i].cid = null;
      if (room.state === 'lobby') { room.slots[i].ready = false; this.sendRoom(room); } else this.sendPresence(room);
      if (room.state === 'playing' && room.snapper === i) this.pickSnapper(room);
    }
    room.touched = this.env.now();
  }
  message(cid, m) {
    const c = this.clients.get(cid); if (!c || !m || typeof m.t !== 'string') return;
    const room = this.roomOf(c);
    switch (m.t) {
      case 'hi': return this.onHi(c, m);
      case 'create': return this.onCreate(c);
      case 'join': return this.onJoin(c, m);
      case 'leave': return this.onLeave(c);
    }
    if (!room) return;
    const si = this.slotOf(room, c); if (si < 0) return;
    if (room.state === 'lobby') {
      switch (m.t) {
        case 'cfg': if (room.slots[si].tok === room.hostTok && m.cfg) { room.cfg = Object.assign({}, MP_CFG_DEFAULT, room.cfg, this.cleanCfg(m.cfg)); for (const s of room.slots) if (s.kind === 'human') s.ready = s.tok === room.hostTok; this.sendRoom(room); } return;
        case 'slot': return this.onSlot(room, si, m);
        case 'start': return this.onStart(room, si, m);
      }
    } else if (room.state === 'playing') {
      switch (m.t) {
        case 'c': { const pid = room.players.indexOf(si); if (pid >= 0 && typeof m.n === 'string' && Array.isArray(m.a)) room.pending.push([pid, m.n, m.a]); return; }
        case 'h': return this.onHash(room, si, m);
        case 'snap': return this.onSnap(room, si, m);
        case 'ai': { if (room.slots[si].tok !== room.hostTok) return; const pid = m.p | 0, sl = room.players[pid]; if (sl != null && room.slots[sl].kind === 'human' && room.slots[sl].cid == null) room.pending.push([-1, 'ai', [pid, 1]]); return; }
      }
    }
  }
  cleanCfg(c) {
    const o = {}, num = (k, lo, hi) => { if (c[k] != null && isFinite(+c[k])) o[k] = Math.max(lo, Math.min(hi, +c[k])); }, str = k => { if (typeof c[k] === 'string') o[k] = this.clean(c[k], 24); };
    num('size', 40, 220); num('timeLimit', 5, 240); num('startAge', 0, 3); num('popLimit', 25, 400); num('speed', 0.5, 4); num('seed', 0, 999999999);
    ['layout', 'theme', 'victory', 'resLevel', 'startRes'].forEach(str); return o;
  }
  onHi(c, m) {
    c.name = this.clean(m.name, 18) || 'Player';
    const known = m.tok && this.toks.get(m.tok);
    if (known && this.rooms.has(known.code)) {
      const room = this.rooms.get(known.code), i = room.slots.findIndex(s => s.tok === m.tok);
      if (i >= 0 && room.slots[i].kind === 'human') {
        c.tok = m.tok; c.code = room.code;
        const s = room.slots[i]; if (s.cid != null && s.cid !== c.cid) { const old = this.clients.get(s.cid); if (old) { old.code = null; this.tx(old.cid, { t: 'kicked', why: 'You joined from somewhere else.' }); } }
        s.cid = c.cid; s.connected = true; if (room.state === 'lobby') s.name = c.name;
        this.tx(c.cid, { t: 'hi', tok: c.tok, code: room.code });
        room.touched = this.env.now();
        if (room.state === 'lobby') this.sendRoom(room); else { room.pending.push([-1, 'ai', [room.players.indexOf(i), 0]]); this.sendResume(room, i, m.last); this.sendPresence(room); }
        return;
      }
    }
    c.tok = this.newTok(); c.code = null;
    this.tx(c.cid, { t: 'hi', tok: c.tok, code: null });
  }
  onCreate(c) {
    if (this.roomOf(c)) return;
    const code = this.newCode(), room = { code, state: 'lobby', cfg: Object.assign({}, MP_CFG_DEFAULT), hostTok: c.tok, touched: this.env.now(), slots: [], n: 0, pending: [], log: [], snap: null, hashes: new Map(), timer: null, players: [], snapper: -1, snapAt: -1 };
    for (let i = 0; i < MP_SLOTS; i++) room.slots.push({ kind: i === 0 ? 'human' : 'open', tok: i === 0 ? c.tok : null, cid: i === 0 ? c.cid : null, name: i === 0 ? c.name : '', race: 'random', diff: 'normal', ready: true });
    this.rooms.set(code, room); this.toks.set(c.tok, { code }); c.code = code; this.sendRoom(room);
  }
  onJoin(c, m) {
    if (this.roomOf(c)) return;
    const code = this.clean(m.code, 8).toUpperCase(), room = this.rooms.get(code);
    if (!room) return this.tx(c.cid, { t: 'err', m: 'No room with that code.' });
    if (room.state !== 'lobby') return this.tx(c.cid, { t: 'err', m: 'That game has already started. Players who were in it can use Rejoin.' });
    const i = room.slots.findIndex(s => s.kind === 'open');
    if (i < 0) return this.tx(c.cid, { t: 'err', m: 'That room is full.' });
    room.slots[i] = { kind: 'human', tok: c.tok, cid: c.cid, name: c.name, race: 'random', diff: 'normal', ready: false };
    this.toks.set(c.tok, { code }); c.code = code; room.touched = this.env.now(); this.sendRoom(room);
  }
  onLeave(c) {
    const room = this.roomOf(c); if (!room) return;
    const i = this.slotOf(room, c); c.code = null;
    if (i < 0) return;
    if (room.state === 'lobby') {
      this.toks.delete(room.slots[i].tok);
      if (room.slots[i].tok === room.hostTok) {            // the host left: the room closes
        for (const s of room.slots) if (s.kind === 'human' && s.cid != null && s.cid !== c.cid) { const o = this.clients.get(s.cid); if (o) o.code = null; this.tx(s.cid, { t: 'closed', why: 'The host left the room.' }); this.toks.delete(s.tok); }
        this.rooms.delete(room.code);
      } else { room.slots[i] = { kind: 'open', tok: null, cid: null, name: '', race: 'random', diff: 'normal', ready: false }; this.sendRoom(room); }
    } else { room.slots[i].cid = null; this.sendPresence(room); if (room.snapper === i) this.pickSnapper(room); }   // in a game, a player who leaves can rejoin
  }
  onSlot(room, si, m) {
    const i = m.i | 0, s = room.slots[i], mine = room.slots[si], host = mine.tok === room.hostTok, p = m.patch || {}; if (!s) return;
    const race = v => this.clean(v, 20), diffs = ['easy', 'normal', 'hard', 'battle'];
    if (i === si) {
      if (typeof p.race === 'string') { s.race = race(p.race); s.ready = s.tok === room.hostTok; }
      if (typeof p.ready === 'boolean') s.ready = p.ready;
      if (typeof p.name === 'string') s.name = this.clean(p.name, 18) || s.name;
    } else if (host) {
      if (p.kind === 'kick' && s.kind === 'human') { const o = s.cid != null ? this.clients.get(s.cid) : null; if (o) { o.code = null; this.tx(o.cid, { t: 'kicked', why: 'The host removed you from the room.' }); } this.toks.delete(s.tok); room.slots[i] = { kind: 'open', tok: null, cid: null, name: '', race: 'random', diff: 'normal', ready: false }; }
      else if (s.kind !== 'human' && ['open', 'ai', 'closed'].includes(p.kind)) { s.kind = p.kind; s.name = p.kind === 'ai' ? 'Computer' : ''; s.ready = true; }
      if (s.kind === 'ai') { if (typeof p.race === 'string') s.race = race(p.race); if (typeof p.diff === 'string' && diffs.includes(p.diff)) s.diff = p.diff; }
    }
    this.sendRoom(room);
  }
  // ---------------- starting ----------------
  onStart(room, si, m) {
    if (room.slots[si].tok !== room.hostTok) return;
    const o = m.opts, map = m.map;
    if (!o || !Array.isArray(map) || !Array.isArray(o.players) || o.players.length !== map.length || map.length < 2 || map.length > MP_SLOTS) return this.tx(room.slots[si].cid, { t: 'err', m: 'You need at least two realms to start.' });
    for (const sl of map) if (!room.slots[sl] || room.slots[sl].kind === 'open' || room.slots[sl].kind === 'closed') return this.tx(room.slots[si].cid, { t: 'err', m: 'The room changed. Try again.' });
    const humans = room.slots.filter(s => s.kind === 'human');
    if (humans.some(s => !s.ready)) return this.tx(room.slots[si].cid, { t: 'err', m: 'Everyone has to press Ready first.' });
    if (humans.some(s => s.cid == null)) return this.tx(room.slots[si].cid, { t: 'err', m: 'Someone in the room is offline.' });
    room.opts = o; room.players = map.slice(); room.state = 'playing'; room.ms = MP_MS; room.k = Math.max(1, Math.round(20 * (o.speed || 1) * room.ms / 1000));
    room.n = 0; room.pending = []; room.log = []; room.snap = null; room.hashes = new Map(); room.snapper = -1; room.snapAt = -1; room.t0 = this.env.now();
    for (const s of room.slots) if (s.kind === 'human') this.tx(s.cid, { t: 'start', host: s.tok === room.hostTok, opts: room.opts, pid: room.players.indexOf(room.slots.indexOf(s)), k: room.k, ms: room.ms, slots: room.players.map(sl => ({ name: room.slots[sl].name, ai: room.slots[sl].kind === 'ai' })) });
    this.pickSnapper(room); this.sendPresence(room); this.schedule(room);
  }
  schedule(room) {
    const env = this.env, tick = () => {
      if (!this.rooms.has(room.code) || room.state !== 'playing') return;
      if (!room.slots.some(s => s.kind === 'human' && s.cid != null)) { room.t0 = env.now() - room.n * room.ms; room.timer = env.setTimer(tick, room.ms * 5); return; }   // nobody is here: the world waits, frozen, until someone comes back
      const now = env.now(); let due = Math.floor((now - room.t0) / room.ms) - room.n;
      if (due > 3) { room.t0 += (due - 3) * room.ms; due = 3; }                          // the machine stalled: do not burst, just carry on
      for (let q = 0; q < Math.max(1, due); q++) this.turn(room);
      room.timer = env.setTimer(tick, Math.max(1, room.t0 + (room.n + 1) * room.ms - env.now()));
    };
    room.timer = env.setTimer(tick, room.ms);
  }
  turn(room) {
    room.n++; const b = { t: 'b', n: room.n, c: room.pending }; room.pending = []; room.log.push(b);
    this.broadcast(room, b);
    if (room.n % MP_SNAP_EVERY === 0) this.askSnap(room);
  }
  pickSnapper(room) { const humans = room.slots.map((s, i) => [s, i]).filter(([s]) => s.kind === 'human' && s.cid != null); room.snapper = humans.length ? humans[0][1] : -1; }
  askSnap(room) {
    if (room.snapper < 0 || room.slots[room.snapper].cid == null) this.pickSnapper(room);
    if (room.snapper < 0) return; room.snapAt = room.n + 10; this.tx(room.slots[room.snapper].cid, { t: 'snapat', n: room.snapAt });
  }
  onSnap(room, si, m) {
    if (!m.d || typeof m.d !== 'string' || !(m.n > (room.snap ? room.snap.n : 0)) || m.n > room.n) return;
    room.snap = { n: m.n, d: m.d, z: m.z ? 1 : 0 }; room.log = room.log.filter(b => b.n > m.n);
  }
  onHash(room, si, m) {
    const e = room.hashes.get(m.n);
    if (!e) { room.hashes.set(m.n, { h: m.h, by: si }); if (room.hashes.size > 400) { const first = room.hashes.keys().next().value; room.hashes.delete(first); } return; }
    if (e.h !== m.h && !room.desync) { room.desync = m.n; this.broadcast(room, { t: 'desync', n: m.n, a: e.by, b: si }); }
  }
  // ---------------- coming back ----------------
  sendResume(room, i, last) {
    const s = room.slots[i], pid = room.players.indexOf(i); if (pid < 0) return;
    const base = { t: 'resume', host: s.tok === room.hostTok, opts: room.opts, pid, k: room.k, ms: room.ms, slots: room.players.map(sl => ({ name: room.slots[sl].name, ai: room.slots[sl].kind === 'ai' })) };
    const first = room.log.length ? room.log[0].n : room.n + 1, floor = room.snap ? room.snap.n : 0;
    if (typeof last === 'number' && last >= floor && last + 1 >= first - 0 && last <= room.n) { base.catchup = true; base.bundles = room.log.filter(b => b.n > last); }
    else { base.snap = room.snap; base.bundles = room.log.slice(); }
    this.tx(s.cid, base);
  }
  // ---------------- housekeeping ----------------
  sweep() {
    const now = this.env.now();
    for (const [code, room] of this.rooms) {
      const online = room.slots.some(s => s.kind === 'human' && s.cid != null);
      if (online) { room.touched = now; continue; }
      if (now - room.touched > (room.state === 'playing' ? 6 * 3600e3 : 20 * 60e3)) { if (room.timer) this.env.clearTimer(room.timer); for (const s of room.slots) if (s.tok) this.toks.delete(s.tok); this.rooms.delete(code); }
    }
  }
}
