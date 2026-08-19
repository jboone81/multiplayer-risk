// debug.js — Developer/testing helpers. Not part of core game rules.
//
// Currently provides: auto-completing the setup (starting-army placement)
// phase, so testers running multiple browsers don't have to click through
// dozens of placements by hand just to get a game started.
//
// Depends on: PLAYERS, applySetupArmy()/setup.js, log()/rules.js — all
// called at runtime, so load order relative to this file doesn't matter as
// long as they're all present by the time a user clicks the debug button.

'use strict';

// Places every remaining army for every player on a random territory they
// own, cycling through the same turn order the real setup phase uses.
function autoCompleteSetup(state) {
  if (!state || state.phase !== 'setup') return false;

  const maxSteps = 10000; // safety valve against an unexpected infinite loop
  let steps = 0;
  while (state.phase === 'setup' && steps < maxSteps) {
    const player = PLAYERS[state.currentPlayerIndex];
    const owned = Object.keys(state.territories).filter(
      (id) => state.territories[id].owner === player.id
    );
    if (owned.length === 0) break; // shouldn't happen — every player gets territories
    const tid = owned[Math.floor(Math.random() * owned.length)];
    applySetupArmy(state, tid);
    steps++;
  }

  log(state, 'system', 'Debug: auto-placed all starting armies.');
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// FULL-GAME SIMULATION
// ══════════════════════════════════════════════════════════════════════════
//
// Plays out the rest of the game automatically with simple heuristics:
//   - Reinforcements go to the current player's weakest border territory
//     (falls back to their weakest territory overall if they have none).
//   - Attacks are only launched when the attacker outnumbers the defender,
//     picking the biggest edge available; each battle rolls max dice.
//   - Conquests move roughly half the attacking stack forward.
//   - Forced trades and forced placements (from a big hand) resolve
//     automatically.
//   - Fortify is always skipped.
// This is for testing only — quickly reaching a finished game (a winner)
// without playing every turn by hand. It calls the same rules.js functions
// the real UI does, so it can safely resume mid-turn too.

function _findTradeSet(handCardIds) {
  const hand = handCardIds || [];
  for (let i = 0; i < hand.length - 2; i++) {
    for (let j = i + 1; j < hand.length - 1; j++) {
      for (let k = j + 1; k < hand.length; k++) {
        const set = [hand[i], hand[j], hand[k]];
        if (isValidTradeSet(set)) return set;
      }
    }
  }
  return null;
}

function _isBorderTerritory(state, territoryId, playerId) {
  const terr = TERRITORIES[territoryId];
  if (!terr) return false;
  return terr.adjacent.some((nid) => state.territories[nid] && state.territories[nid].owner !== playerId);
}

function _bestReinforceTarget(state, playerId) {
  const owned = Object.keys(state.territories).filter((id) => state.territories[id].owner === playerId);
  if (owned.length === 0) return null;
  const borders = owned.filter((id) => _isBorderTerritory(state, id, playerId));
  const pool = borders.length > 0 ? borders : owned;
  pool.sort((a, b) => state.territories[a].armies - state.territories[b].armies);
  return pool[0];
}

function _botPlaceArmies(state) {
  const player = PLAYERS[state.currentPlayerIndex];
  let guard = 0;
  while (state.armiesRemaining > 0 && guard < 1000) {
    const tid = _bestReinforceTarget(state, player.id);
    if (!tid) break; // shouldn't happen — the current player always owns territory
    applyReinforce(state, tid);
    guard++;
  }
}

function _bestAttack(state) {
  // Picks the weakest available favorable target (not the biggest edge).
  // Two big stacks trading marginal-edge attacks tends to grind forever —
  // reinforcements refill both sides every turn and neither one ever lands
  // a knockout. Going after the weakest neighbor instead snowballs toward
  // eliminations, which is what actually finishes a simulated game.
  const player = PLAYERS[state.currentPlayerIndex];
  let best = null;
  let bestDefenderArmies = Infinity;
  for (const [tid, t] of Object.entries(state.territories)) {
    if (t.owner !== player.id || t.armies < 2) continue;
    const terr = TERRITORIES[tid];
    if (!terr) continue;
    for (const nid of terr.adjacent) {
      const n = state.territories[nid];
      if (!n || n.owner === player.id) continue;
      if (t.armies <= n.armies) continue; // only favorable attacks
      if (n.armies < bestDefenderArmies) { bestDefenderArmies = n.armies; best = { attackerId: tid, defenderId: nid }; }
    }
  }
  return best; // null once nothing looks favorable — bot stops attacking for the turn
}

// Resolves the whole attack phase for the current player: keeps fighting
// favorable battles, handling forced trades/placements/conquests as they
// come up, until nothing favorable is left or the per-turn roll cap hits.
// The roll cap is only checked before *starting* a new attack, so it never
// leaves a conquest half-resolved.
function _botRunAttackPhase(state, maxRolls) {
  let rolls = 0;
  while (state.phase === 'attack') {
    if (state.attackTradeRequired) {
      const player = PLAYERS[state.currentPlayerIndex];
      const set = _findTradeSet(state.hands[player.id]);
      if (!set) break; // shouldn't happen — a hand of 5+ always contains a valid set
      applyTradeIn(state, set);
      continue;
    }
    if (state.forcedPlacement) {
      _botPlaceArmies(state);
      continue;
    }
    if (state.pendingConquest) {
      const pc = state.pendingConquest;
      const move = Math.max(pc.minMove, Math.min(pc.maxMove, Math.ceil((pc.minMove + pc.maxMove) / 2)));
      applyConquest(state, move);
      continue;
    }
    if (rolls >= maxRolls) break;
    const target = _bestAttack(state);
    if (!target) break;
    rolls++;
    performBattle(state, target.attackerId, target.defenderId, null);
  }
}

// Plays the game to completion (or until the safety cap trips). Safe to
// call whether the game is mid-setup, mid-turn, or fresh.
function simulateWholeGame(state, options) {
  if (!state) return false;
  const maxTurns        = (options && options.maxTurns) || 500;
  const maxRollsPerTurn = (options && options.maxRollsPerTurn) || 500;

  if (state.phase === 'setup') autoCompleteSetup(state);

  let turns = 0;
  while (state.phase !== 'gameover' && turns < maxTurns) {
    if (state.phase === 'reinforce') {
      let tradeGuard = 0;
      while (mustTradeIn(state) && tradeGuard < 20) {
        const player = PLAYERS[state.currentPlayerIndex];
        const set = _findTradeSet(state.hands[player.id]);
        if (!set) break;
        applyTradeIn(state, set);
        tradeGuard++;
      }
      _botPlaceArmies(state);
      endReinforce(state);
    } else if (state.phase === 'attack') {
      _botRunAttackPhase(state, maxRollsPerTurn);
      if (state.phase === 'gameover') break;
      endAttack(state);
    } else if (state.phase === 'fortify') {
      skipFortify(state);
      advanceTurn(state);
    } else {
      break; // unexpected phase — bail rather than spin forever
    }
    turns++;
  }

  if (state.phase === 'gameover') {
    log(state, 'system', 'Debug: full-game simulation complete.');
  } else {
    log(state, 'system', `Debug: simulation stopped after ${turns} turns without a winner (safety cap).`);
  }
  return state.phase === 'gameover';
}

// ══════════════════════════════════════════════════════════════════════════
// RIGGED COMBAT ("always win")
// ══════════════════════════════════════════════════════════════════════════
//
// Forces every battle a given player is in — attacking or defending — to
// go their way: their dice always show 6, the opponent's always show 1, so
// there's never a tie for the real "ties go to the defender" rule to spoil.
// Implemented by wrapping rules.js's performBattle() rather than editing
// it, so normal combat for everyone else is untouched byte-for-byte.

let _debugAlwaysWinPlayerId = null;

function setAlwaysWinPlayer(playerId) { _debugAlwaysWinPlayerId = playerId; }
function clearAlwaysWinPlayer() { _debugAlwaysWinPlayerId = null; }
function getAlwaysWinPlayer() { return _debugAlwaysWinPlayerId; }

const _realPerformBattle = performBattle;

performBattle = function (state, attackerId, defenderId, requestedAttackerDice) {
  if (!_debugAlwaysWinPlayerId) {
    return _realPerformBattle(state, attackerId, defenderId, requestedAttackerDice);
  }

  const a = state.territories[attackerId];
  const d = state.territories[defenderId];
  if (!a || !d) return _realPerformBattle(state, attackerId, defenderId, requestedAttackerDice);

  const attackerIsForced = a.owner === _debugAlwaysWinPlayerId;
  const defenderIsForced = d.owner === _debugAlwaysWinPlayerId;

  // Doesn't involve the rigged player — resolve normally.
  if (!attackerIsForced && !defenderIsForced) {
    return _realPerformBattle(state, attackerId, defenderId, requestedAttackerDice);
  }

  if (!canAttack(state, attackerId, defenderId)) return null;

  const maxA = getMaxAttackerDice(state, attackerId);
  const maxD = getMaxDefenderDice(state, defenderId);
  const aDice = Math.max(1, Math.min(requestedAttackerDice || maxA, maxA));
  const dDice = maxD;

  const aRolls = new Array(aDice).fill(attackerIsForced ? 6 : 1);
  const dRolls = new Array(dDice).fill(defenderIsForced ? 6 : 1);

  const { attackerLosses, defenderLosses } = resolveBattleRolls(aRolls, dRolls);

  a.armies -= attackerLosses;
  d.armies -= defenderLosses;

  const conquered   = d.armies <= 0;
  const mustRetreat = !conquered && a.armies < 2;

  log(state, 'attack',
    `${_terrName(attackerId)} attacks ${_terrName(defenderId)} — attacker rolls [${aRolls.join(', ')}], defender rolls [${dRolls.join(', ')}]. ` +
    `Losses: attacker −${attackerLosses}, defender −${defenderLosses}. (Debug: rigged)`);

  if (conquered) {
    state.pendingConquest = {
      attackerId, defenderId,
      minMove: aDice,
      maxMove: Math.max(1, a.armies - 1),
      attackerDiceUsed: aDice
    };
    log(state, 'conquest', `${PLAYERS[state.currentPlayerIndex].name} conquered ${_terrName(defenderId)}!`);
  }

  return {
    attackerRolls: aRolls, defenderRolls: dRolls,
    attackerLosses, defenderLosses,
    conquered, mustRetreat,
    attackerDiceUsed: aDice, defenderDiceUsed: dDice
  };
};

// Shows/hides debug controls based on the current phase. Call from the
// main render loop alongside the other render* functions.
function renderDebugControls(state) {
  if (!state) return;

  // In local/dev play there's no real identity, so these are always
  // available (matches how this always worked). In a live server-synced
  // game (MY_PLAYER_ID set), only the room's host may use them — the
  // server enforces this too (_requireHostWithActiveGame), but hiding the
  // controls for everyone else avoids a confusing "why didn't that work"
  // moment. (main.js also skips wiring non-host click handlers — this is
  // belt-and-braces, not the only guard.)
  const liveGame = typeof MY_PLAYER_ID !== 'undefined' && !!MY_PLAYER_ID;
  const canUseDebugTools = !liveGame || (typeof IS_HOST !== 'undefined' && IS_HOST);

  const autoSetupBtn = document.getElementById('btn-debug-autosetup');
  if (autoSetupBtn) autoSetupBtn.classList.toggle('hidden', !canUseDebugTools || state.phase !== 'setup');

  const simulateBtn = document.getElementById('btn-debug-simulate');
  if (simulateBtn) simulateBtn.classList.toggle('hidden', !canUseDebugTools || state.phase === 'gameover');

  const alwaysWinLabel = document.getElementById('debug-always-win-label');
  const alwaysWinText  = document.getElementById('debug-always-win-text');
  if (alwaysWinLabel) alwaysWinLabel.classList.toggle('hidden', !canUseDebugTools || state.phase === 'gameover');
  if (alwaysWinText && PLAYERS[1]) alwaysWinText.textContent = `Always-Win ${PLAYERS[1].name} (Debug)`;
}
