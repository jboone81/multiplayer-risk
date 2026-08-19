// setup.js — Initial "place your armies" phase.
//
// Territories are still dealt out randomly, round-robin (see state.js).
// But instead of auto-distributing each player's leftover starting armies
// across their own territories, players place them by hand, one army at a
// time, taking turns in player order until everyone is out. This mirrors
// the setup phase of physical Risk.
//
// Depends on: PLAYERS, GAME_STATE shape from state.js; log() from rules.js;
// beginReinforce() from rules.js (called once setup is complete).

'use strict';

const PHASE_SETUP = 'setup';

function setupArmiesLeft(state, playerId) {
  return (state.setupRemaining && state.setupRemaining[playerId]) || 0;
}

function isSetupComplete(state) {
  if (!state.setupRemaining) return true;
  return Object.values(state.setupRemaining).every((n) => n <= 0);
}

function _firstSetupPlayerIndex(state, fromIndex) {
  const n = PLAYERS.length;
  for (let i = 0; i < n; i++) {
    const idx = (fromIndex + i) % n;
    if (setupArmiesLeft(state, PLAYERS[idx].id) > 0) return idx;
  }
  return fromIndex;
}

function beginSetup(state) {
  state.phase = PHASE_SETUP;
  state.currentPlayerIndex = _firstSetupPlayerIndex(state, 0);
  const player = PLAYERS[state.currentPlayerIndex];
  log(state, 'phase',
    `Setup phase — place your starting armies. ${player.name} goes first (${setupArmiesLeft(state, player.id)} to place).`);
}

function canPlaceSetupArmy(state, territoryId) {
  if (state.phase !== PHASE_SETUP) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  if (setupArmiesLeft(state, player.id) <= 0) return false;
  const t = state.territories[territoryId];
  return !!t && t.owner === player.id;
}

function applySetupArmy(state, territoryId) {
  if (!canPlaceSetupArmy(state, territoryId)) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  state.territories[territoryId].armies += 1;
  state.setupRemaining[player.id] -= 1;

  if (isSetupComplete(state)) {
    log(state, 'phase', 'All starting armies placed — Round 1 begins.');
    state.currentPlayerIndex = 0;
    state.phase = 'reinforce';
    if (typeof beginReinforce === 'function') beginReinforce(state);
    return true;
  }

  state.currentPlayerIndex = _firstSetupPlayerIndex(state, state.currentPlayerIndex + 1);
  const nextPlayer = PLAYERS[state.currentPlayerIndex];
  log(state, 'phase', `${nextPlayer.name}'s turn to place (${setupArmiesLeft(state, nextPlayer.id)} left).`);
  return true;
}
