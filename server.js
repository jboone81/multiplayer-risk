// server.js — Phase 3 Chunk A: lobby + room manager.
//
// Serves the game's static files, and runs a Socket.IO endpoint that lets
// clients create rooms, join by code, and start games.
//
// Chunk B (next) moves the game rules onto this server and wires each action.
// Chunk C adds reconnection and deployment polish.

'use strict';

const path      = require('path');
const http      = require('http');
const crypto    = require('crypto');
const express   = require('express');
const { Server: SocketIO } = require('socket.io');
const gameEngine = require('./gameEngine');

// ── Config ───────────────────────────────────────────────────────────────
const PORT              = process.env.PORT || 3000;
const MAX_PLAYERS       = 6;
const MIN_PLAYERS       = 2;
const ROOM_CODE_LENGTH  = 5;
const ROOM_CODE_ALPHA   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit look-alike chars

// ── Express + static files ──────────────────────────────────────────────
const app = express();
app.use(express.json());
// Serve the entire game folder (index.html, JS files, style.css, assets/, etc.)
// as the site root. That means /lobby.html, /assets/risk-map.png, etc. all
// resolve to files in this same directory.
app.use(express.static(__dirname, { extensions: ['html'] }));

// Redirect the root path to the lobby.
app.get('/', (_req, res) => res.redirect('/lobby.html'));

// Lets index.html look up the room's actual player roster (name/color chosen
// in the lobby) after gameStarting redirects the browser to ?room=CODE. This
// is a fallback path only — the primary way a client gets its game state now
// is the joinGame socket handshake (see below), which returns a state
// personalized for that specific player. This REST route has no notion of
// "who's asking" (it's an unauthenticated GET), so if a game has started, it
// redacts every player's hand rather than leaking everyone's cards to
// whoever has the room code.
app.get('/api/room/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found.' });
  res.json({
    ok:        true,
    code:      room.code,
    status:    room.status,
    hostId:    room.hostId,
    players:   room.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    gameState: room.gameState ? personalizeGameState(room.gameState, null) : null,
    continentBonuses: room.continentBonuses || null
  });
});

const server = http.createServer(app);
const io = new SocketIO(server);

// ── In-memory room registry ─────────────────────────────────────────────
// One entry per active room, keyed by 5-char room code.
//
// Room shape:
//   {
//     code:      string,
//     hostId:    string    // stable playerId (see below) of the host
//     players:   [{ id, socketId, name, color, ready }]
//     status:    'lobby' | 'active' | 'finished'
//     createdAt: number
//     engine:    the room's gameEngine instance, once started
//     gameState: the engine's current GAME_STATE, once started
//   }
//
// player.id is a STABLE identity generated once at createRoom/joinRoom
// time — deliberately NOT the socket id. A player's lobby socket dies the
// moment their browser navigates from lobby.html to index.html (that's a
// full page load), so anything keyed by socket.id would break the instant
// the game starts. player.socketId tracks whichever live connection is
// currently "them"; the joinGame handler below is what rebinds a fresh
// socket (after that navigation, or a reconnect) back to its stable id.

const rooms = new Map();

function generatePlayerId() {
  return crypto.randomUUID();
}

// Preset player colors — mirrors PLAYERS in state.js. Assigned in order as
// people join; can be reshuffled in the UI later.
const PRESET_COLORS = [
  { name: 'Red',    hex: '#e05252' },
  { name: 'Blue',   hex: '#4a8fd4' },
  { name: 'Green',  hex: '#4caf6e' },
  { name: 'Yellow', hex: '#f0d040' },
  { name: 'Pink',   hex: '#ec6ba0' },
  { name: 'Black',  hex: '#2a2a2a' }
];

// Continent bonus-army metadata — mirrors CONTINENTS in map.js (id, display
// name, and the default bonus). Kept as a small standalone list here (rather
// than loading map.js itself) since the lobby has no need for the rest of
// the map data, just these six numbers for the host's settings panel.
// Host-adjustable per room, applied to the real engine's CONTINENTS object
// at game-start time — see gameEngine.js's setContinentBonuses().
const CONTINENT_META = [
  { id: 'northAmerica', name: 'North America', defaultBonus: 5 },
  { id: 'southAmerica', name: 'South America', defaultBonus: 2 },
  { id: 'europe',       name: 'Europe',        defaultBonus: 5 },
  { id: 'africa',       name: 'Africa',        defaultBonus: 3 },
  { id: 'asia',         name: 'Asia',          defaultBonus: 7 },
  { id: 'australia',    name: 'Australia',     defaultBonus: 2 }
];
const CONTINENT_BONUS_MIN = 1;
const CONTINENT_BONUS_MAX = 15;

function defaultContinentBonuses() {
  const bonuses = {};
  for (const c of CONTINENT_META) bonuses[c.id] = c.defaultBonus;
  return bonuses;
}

function generateRoomCode() {
  let code;
  let tries = 0;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHA[Math.floor(Math.random() * ROOM_CODE_ALPHA.length)];
    }
    tries++;
  } while (rooms.has(code) && tries < 50);
  return code;
}

function pickAvailableColor(room) {
  const taken = new Set(room.players.map(p => p.color.hex));
  return PRESET_COLORS.find(c => !taken.has(c.hex)) || PRESET_COLORS[0];
}

function publicRoomState(room) {
  // What we broadcast to everyone in the room — safe to send as-is (no secrets).
  return {
    code:     room.code,
    hostId:   room.hostId,
    status:   room.status,
    players:  room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready
    })),
    // Continent bonus settings — everyone sees the current values, only the
    // host can change them (see the setContinentBonus handler below).
    continents: CONTINENT_META.map(c => ({
      id:   c.id,
      name: c.name,
      bonus: (room.continentBonuses && room.continentBonuses[c.id]) || c.defaultBonus
    }))
  };
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('roomState', publicRoomState(room));
}

// Redacts one already-deep-cloned state object for `forPlayerId`: every
// other player's card hand is replaced with same-length placeholders so
// opponent hand *counts* still render correctly client-side, but nobody can
// read anyone else's cards out of the network payload. Only shallow-copies
// the top level (fresh `hands`, everything else shared by reference with
// `baseClone`) — safe because the result is only ever read once, by
// socket.io's own JSON.stringify when it's emitted, never mutated after.
function personalizeClone(baseClone, forPlayerId) {
  const filteredHands = {};
  for (const pid of Object.keys(baseClone.hands || {})) {
    filteredHands[pid] = (pid === forPlayerId)
      ? baseClone.hands[pid]
      : new Array(baseClone.hands[pid].length).fill(null);
  }
  return { ...baseClone, hands: filteredHands };
}

// Returns a copy of gameState safe to send to `forPlayerId`. Used by the
// one-off call sites (REST room lookup, the joinGame handshake) that only
// need a single player's view — see broadcastGameState below for the
// multi-player broadcast path, which clones once and reuses it.
function personalizeGameState(state, forPlayerId) {
  return personalizeClone(JSON.parse(JSON.stringify(state)), forPlayerId);
}

// Sends every connected player their own personalized view of the room's
// current game state. Players without a live socket right now (e.g. mid
// page-navigation) are simply skipped — they'll catch up via joinGame's
// ack, or the next broadcast after that lands.
//
// Deep-clones the state exactly ONCE per broadcast (not once per player —
// that used to mean up to 6 full JSON.stringify/parse passes over the same
// state, including the game log, for a single action). Each player's
// personalized view is then a cheap shallow copy of that one clone with
// just its own `hands` field swapped in.
function broadcastGameState(room) {
  if (!room || !room.gameState) return;
  const baseClone = JSON.parse(JSON.stringify(room.gameState));
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit('gameState', personalizeClone(baseClone, player.id));
  }
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  // Once the game has left the lobby, don't strip the player from the
  // roster just because their lobby socket disconnected — that happens for
  // EVERY player as their browser navigates from lobby.html to index.html
  // when the game starts. Removing them here was a race: whichever browser
  // fetched /api/room/:code after others had already disconnected saw a
  // shrunk roster (or, if everyone disconnected first, a deleted room),
  // so the game board ended up with fewer players than the lobby had.
  if (room.status !== 'lobby') {
    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    return;
  }

  const idx = room.players.findIndex(p => p.id === socket.data.playerId);
  if (idx === -1) return;
  const [gone] = room.players.splice(idx, 1);

  // Reassign host if the host left
  if (gone.id === room.hostId && room.players.length > 0) {
    room.hostId = room.players[0].id;
  }

  if (room.players.length === 0) {
    rooms.delete(code);
    console.log(`[room ${code}] destroyed (empty)`);
  } else {
    broadcastRoom(code);
  }

  socket.leave(code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
}

// ── Socket.IO event handlers ────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.data = { roomCode: null, playerId: null };
  console.log(`[socket] connected: ${socket.id}`);

  // Create a new room. Payload: { name }
  socket.on('createRoom', (payload, ack) => {
    const name = sanitizeName(payload && payload.name);
    if (!name) return ack && ack({ ok: false, error: 'Name is required.' });
    if (socket.data.roomCode) return ack && ack({ ok: false, error: 'Already in a room.' });

    const code = generateRoomCode();
    const playerId = generatePlayerId();
    const player = {
      id:       playerId,
      socketId: socket.id,
      name,
      color: PRESET_COLORS[0],
      ready: false
    };
    const room = {
      code,
      hostId:   playerId,
      players:  [player],
      status:   'lobby',
      createdAt: Date.now(),
      continentBonuses: defaultContinentBonuses()
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[room ${code}] created by ${name}`);
    ack && ack({ ok: true, code, playerId });
    broadcastRoom(code);
  });

  // Join an existing room. Payload: { code, name }
  socket.on('joinRoom', (payload, ack) => {
    const code = (payload && payload.code || '').toUpperCase().trim();
    const name = sanitizeName(payload && payload.name);
    if (!code || !name) return ack && ack({ ok: false, error: 'Room code and name required.' });
    if (socket.data.roomCode) return ack && ack({ ok: false, error: 'Already in a room.' });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'Room not found.' });
    if (room.status !== 'lobby') return ack && ack({ ok: false, error: 'Game already started.' });
    if (room.players.length >= MAX_PLAYERS) return ack && ack({ ok: false, error: 'Room is full.' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return ack && ack({ ok: false, error: 'Name already taken in this room.' });
    }

    const playerId = generatePlayerId();
    const player = {
      id:       playerId,
      socketId: socket.id,
      name,
      color: pickAvailableColor(room),
      ready: false
    };
    room.players.push(player);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[room ${code}] ${name} joined (${room.players.length}/${MAX_PLAYERS})`);
    ack && ack({ ok: true, code, playerId });
    broadcastRoom(code);
  });

  // Toggle ready state (lobby only).
  socket.on('toggleReady', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return ack && ack({ ok: false, error: 'Player not found.' });
    player.ready = !player.ready;
    broadcastRoom(room.code);
    ack && ack({ ok: true, ready: player.ready });
  });

  // Change color. Payload: { hex } — must be one of PRESET_COLORS.
  socket.on('changeColor', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const hex = payload && payload.hex;
    const preset = PRESET_COLORS.find(c => c.hex === hex);
    if (!preset) return ack && ack({ ok: false, error: 'Invalid color.' });
    if (room.players.some(p => p.id !== socket.data.playerId && p.color.hex === hex)) {
      return ack && ack({ ok: false, error: 'Color already taken.' });
    }
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return ack && ack({ ok: false, error: 'Player not found.' });
    player.color = preset;
    broadcastRoom(room.code);
    ack && ack({ ok: true });
  });

  // Host-only: adjust a continent's bonus-army value before the game
  // starts. Payload: { continentId, bonus }. Applied to the real engine's
  // CONTINENTS data at startGame time (gameEngine.js's setContinentBonuses).
  socket.on('setContinentBonus', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    if (room.hostId !== socket.data.playerId) return ack && ack({ ok: false, error: 'Only the host can change this.' });
    if (room.status !== 'lobby') return ack && ack({ ok: false, error: 'Game already started.' });

    const continentId = payload && payload.continentId;
    const meta = CONTINENT_META.find(c => c.id === continentId);
    if (!meta) return ack && ack({ ok: false, error: 'Unknown continent.' });

    let bonus = Number(payload && payload.bonus);
    if (!Number.isFinite(bonus)) return ack && ack({ ok: false, error: 'Invalid bonus value.' });
    bonus = Math.round(Math.max(CONTINENT_BONUS_MIN, Math.min(CONTINENT_BONUS_MAX, bonus)));

    if (!room.continentBonuses) room.continentBonuses = defaultContinentBonuses();
    room.continentBonuses[continentId] = bonus;

    broadcastRoom(room.code);
    ack && ack({ ok: true, bonus });
  });

  // Start game — host only. All players must be ready, and there must be
  // between MIN_PLAYERS and MAX_PLAYERS.
  socket.on('startGame', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    if (room.hostId !== socket.data.playerId) return ack && ack({ ok: false, error: 'Only the host can start.' });
    if (room.players.length < MIN_PLAYERS) return ack && ack({ ok: false, error: `Need at least ${MIN_PLAYERS} players.` });
    if (!room.players.every(p => p.ready)) return ack && ack({ ok: false, error: 'All players must be ready.' });

    room.status = 'active';

    // Build the canonical board once, server-side. From here on this
    // room's engine is the single source of truth — every turn-by-turn
    // action (place army, attack, fortify, ...) comes back through the
    // gameAction handler below and gets validated/applied here, not in
    // any player's browser. See gameEngine.js for how that dispatch works.
    try {
      room.engine = gameEngine.createEngine();
      // Apply the host's continent bonus settings (if any were changed from
      // default) before building the board — buildGame()'s own reinforcement
      // math reads CONTINENTS[id].bonus live on every turn afterward, so
      // setting it once here up front is all that's needed for the whole game.
      room.engine.setContinentBonuses(room.continentBonuses);
      room.gameState = room.engine.buildGame(
        room.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
        room.code
      );
      console.log(`[room ${room.code}] server-built game state (${room.players.length} players)`);
    } catch (err) {
      console.error(`[room ${room.code}] failed to build server-side game state, clients will fall back to building their own:`, err);
      room.engine = null;
      room.gameState = null;
    }

    console.log(`[room ${room.code}] game started with ${room.players.length} players`);
    ack && ack({ ok: true });
    io.to(room.code).emit('gameStarting', { code: room.code });
    broadcastRoom(room.code);
  });

  // Rebinds a fresh socket to an existing player seat in an already-started
  // game. Needed because the lobby socket that created/joined the room dies
  // the instant the browser navigates from lobby.html to index.html — this
  // is how the new page's socket proves "I'm the same Bob who was in the
  // lobby" using the stable playerId the lobby handed it. Payload: { code, playerId }
  socket.on('joinGame', (payload, ack) => {
    const code = (payload && payload.code || '').toUpperCase().trim();
    const playerId = payload && payload.playerId;
    if (!code || !playerId) return ack && ack({ ok: false, error: 'Room code and player id required.' });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'Room not found.' });
    if (room.status !== 'active' || !room.gameState) {
      return ack && ack({ ok: false, error: 'Game has not started yet.' });
    }
    const player = room.players.find(p => p.id === playerId);
    if (!player) return ack && ack({ ok: false, error: 'You are not a player in this game.' });

    player.socketId = socket.id;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[room ${code}] ${player.name} connected to the live game`);
    ack && ack({
      ok: true,
      playerId,
      isHost: playerId === room.hostId,
      gameState: personalizeGameState(room.gameState, playerId),
      // So this browser's own CONTINENTS.bonus values (used for display,
      // and for local math in dev-fallback mode) match what the host
      // configured in the lobby, rather than map.js's hardcoded defaults.
      continentBonuses: room.continentBonuses || null
    });
  });

  // The one gateway for every turn-by-turn game action. Payload:
  // { type, args }. Validated and applied by the room's engine (which runs
  // the exact same rules.js the browser uses — see gameEngine.js), then
  // the resulting state is broadcast to everyone in the room, each player
  // getting their own hand-filtered view.
  socket.on('gameAction', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const playerId = socket.data.playerId;
    if (!room || !playerId) return ack && ack({ ok: false, error: 'Not joined to a game.' });
    if (!room.engine || !room.gameState) return ack && ack({ ok: false, error: 'Game not active.' });

    const type = payload && payload.type;
    const args = (payload && payload.args) || {};

    let outcome;
    try {
      outcome = room.engine.applyAction(playerId, type, args);
    } catch (err) {
      console.error(`[room ${room.code}] error applying action '${type}':`, err);
      return ack && ack({ ok: false, error: 'Server error applying that action.' });
    }

    if (!outcome || !outcome.ok) {
      return ack && ack({ ok: false, error: (outcome && outcome.error) || 'Action rejected.' });
    }

    room.gameState = room.engine.getState();
    ack && ack({ ok: true, result: outcome.result });
    broadcastGameState(room);
  });

  // Shared guard for the debug handlers below: only the room's host may
  // use them, and only once the game is actually running. These bypass
  // turn ownership entirely (that's the point — they're for setting up
  // test scenarios), so this check is the only thing standing between "the
  // host is testing something" and "any player can rig the game."
  function _requireHostWithActiveGame(socket) {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (socket.data.playerId !== room.hostId) return { ok: false, error: 'Only the host can use debug tools.' };
    if (!room.engine || !room.gameState) return { ok: false, error: 'Game not active.' };
    return { ok: true, room };
  }

  // Debug: instantly place every player's remaining starting armies.
  socket.on('debugAutoSetup', (_payload, ack) => {
    const check = _requireHostWithActiveGame(socket);
    if (!check.ok) return ack && ack(check);
    check.room.gameState = check.room.engine.debugAutoCompleteSetup();
    ack && ack({ ok: true });
    broadcastGameState(check.room);
  });

  // Debug: auto-play the rest of the game to a finish (or a safety cap).
  socket.on('debugSimulate', (payload, ack) => {
    const check = _requireHostWithActiveGame(socket);
    if (!check.ok) return ack && ack(check);
    check.room.gameState = check.room.engine.debugSimulateWholeGame(payload || undefined);
    ack && ack({ ok: true });
    broadcastGameState(check.room);
  });

  // Debug: rig combat so the given playerId always wins (or clear the rig
  // when playerId is falsy). Payload: { playerId }
  socket.on('debugAlwaysWin', (payload, ack) => {
    const check = _requireHostWithActiveGame(socket);
    if (!check.ok) return ack && ack(check);
    const targetId = payload && payload.playerId;
    if (targetId) {
      check.room.engine.debugSetAlwaysWinPlayer(targetId);
      const target = check.room.players.find(p => p.id === targetId);
      check.room.engine.call('log', 'system', `Debug: rigged combat on — ${target ? target.name : targetId} always wins.`);
    } else {
      check.room.engine.debugClearAlwaysWinPlayer();
      check.room.engine.call('log', 'system', 'Debug: rigged combat off.');
    }
    check.room.gameState = check.room.engine.getState();
    ack && ack({ ok: true });
    broadcastGameState(check.room);
  });

  // Explicit leave.
  socket.on('leaveRoom', (_payload, ack) => {
    removePlayer(socket);
    ack && ack({ ok: true });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    removePlayer(socket);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 24);
  if (!trimmed) return null;
  // Strip anything weird; keep letters, digits, spaces, dashes, underscores, apostrophes
  const cleaned = trimmed.replace(/[^\p{L}\p{N}\s\-_'.]/gu, '');
  return cleaned || null;
}

// ── Boot ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  Risk multiplayer server running on http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT}/lobby.html in a browser to join a game.\n`);
});
