// state.js — Builds the initial game state from the lobby's actual player
// roster (name/color chosen in lobby.html) instead of a hardcoded roster.
//
// buildGameState(rawPlayers, roomCode) is called once from main.js after it
// has fetched the room's player list from the server. If no lobby roster is
// available (e.g. index.html opened directly during dev, with no ?room=
// code), DEFAULT_PLAYERS is used as a fallback so the board still loads.

'use strict';

// Fallback roster — only used when there's no lobby room to pull from.
const DEFAULT_PLAYERS = [
  { id: 'player1', name: 'Commander Red',  color: '#e05252' },
  { id: 'player2', name: 'Admiral Blue',   color: '#4a8fd4' },
  { id: 'player3', name: 'General Green',  color: '#4caf6e' }
];

// Standard Risk starting-army counts by player count.
const STARTING_ARMIES_BY_COUNT = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };

let PLAYERS    = [];
let GAME_STATE = null;

function _hexOf(color) {
  if (!color) return '#999999';
  return (typeof color === 'string') ? color : (color.hex || '#999999');
}

function _darken(hex, factor) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (isNaN(n)) return hex;
  const r = Math.floor(((n >> 16) & 0xff) * factor);
  const g = Math.floor(((n >> 8) & 0xff) * factor);
  const b = Math.floor((n & 0xff) * factor);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function _normalizePlayers(rawPlayers) {
  const list = (rawPlayers && rawPlayers.length) ? rawPlayers : DEFAULT_PLAYERS;
  return list.map((p) => {
    const hex = _hexOf(p.color);
    return {
      id:        p.id,
      name:      p.name,
      color:     hex,
      darkColor: p.darkColor || _darken(hex, 0.6)
    };
  });
}

// Deals every territory round-robin among the given players (shuffled order),
// 1 army each. Each player's leftover starting armies are NOT auto-placed —
// they're handed back as `remaining` so the setup phase (setup.js) can let
// each player place them by hand.
function _dealTerritories(players) {
  const shuffledIds = shuffle(Object.keys(TERRITORIES));
  const territories = {};

  shuffledIds.forEach((id, i) => {
    territories[id] = { owner: players[i % players.length].id, armies: 1 };
  });

  const totalStart = STARTING_ARMIES_BY_COUNT[players.length]
    || Math.max(20, 40 - Math.max(0, players.length - 2) * 5);

  const remaining = {};
  players.forEach((p) => {
    const owned = shuffledIds.filter((id) => territories[id].owner === p.id).length;
    remaining[p.id] = Math.max(0, totalStart - owned);
  });

  return { territories, remaining };
}

// Builds a brand-new GAME_STATE (and sets the global PLAYERS) for the given
// lobby roster. Call once, then call beginReinforce(GAME_STATE) to kick off
// round 1.
function buildGameState(rawPlayers, roomCode) {
  PLAYERS = _normalizePlayers(rawPlayers);

  const { territories, remaining } = _dealTerritories(PLAYERS);

  GAME_STATE = {
    room:               roomCode || null,
    players:            PLAYERS,

    round:              1,
    phase:              'setup',
    currentPlayerIndex: 0,

    armiesRemaining:    0,
    setupRemaining:     remaining,

    attackSelection:      null,
    pendingConquest:      null,
    conqueredThisTurn:    false,

    attackTradeRequired:  false,
    forcedPlacement:      false,

    fortifySelection:   null,
    hasFortified:       false,

    deck:               shuffle(allCardIds()),
    discardPile:        [],
    hands:              Object.fromEntries(PLAYERS.map((p) => [p.id, []])),
    tradeInCount:       0,

    winner:             null,

    gameLog: [
      {
        type: 'system',
        text: `Game start. ${PLAYERS.length} players. Territories dealt — place your starting armies.`,
        round: 1,
        phase: 'setup'
      }
    ],

    territories
  };

  return GAME_STATE;
}
