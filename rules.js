// rules.js — Pure game logic. No DOM, no rendering.
//
// Phases: reinforce → attack → fortify → next player.
// Also implements:
//   * Escalating card trade-in values (4, 6, 8, 10, 12, 15, 20, 25, +5...)
//   * Per-card +2 territory bonus for owned cards traded
//   * Full connected-chain fortify (BFS through own territories)
//   * Blitz combat + move-armies-after-conquest
//   * Elimination (transfer cards to attacker) + game over
//   * Forced re-trade after elimination: if hand ≥ 5 during attack, must
//     trade in a set before continuing. The traded armies enter a
//     "forced placement" sub-phase — placed on owned territories (using
//     the reinforce click UI) before attacks can resume.

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const MIN_REINFORCE = 3;
const MAX_HAND_SIZE_BEFORE_FORCED_TRADE = 5;

const PHASE_REINFORCE = 'reinforce';
const PHASE_ATTACK    = 'attack';
const PHASE_FORTIFY   = 'fortify';
const PHASE_GAMEOVER  = 'gameover';

// ══════════════════════════════════════════════════════════════════════════
// REINFORCEMENT CALCULATION
// ══════════════════════════════════════════════════════════════════════════

function countTerritories(state, playerId) {
  let count = 0;
  for (const t of Object.values(state.territories)) if (t.owner === playerId) count++;
  return count;
}

function fullyControlledContinents(state, playerId) {
  const owned = [];
  for (const cont of Object.values(CONTINENTS)) {
    const all = cont.territories.every(tid => state.territories[tid] && state.territories[tid].owner === playerId);
    if (all) owned.push(cont.id);
  }
  return owned;
}

function calculateReinforcements(state, playerId) {
  const territories = countTerritories(state, playerId);
  const base = Math.max(MIN_REINFORCE, Math.floor(territories / 3));
  const continents = fullyControlledContinents(state, playerId);
  const contBonus = continents.reduce((sum, cid) => sum + CONTINENTS[cid].bonus, 0);
  return { base, continents, contBonus, total: base + contBonus };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE TRANSITIONS
// ══════════════════════════════════════════════════════════════════════════

function beginReinforce(state) {
  const player = PLAYERS[state.currentPlayerIndex];
  const r = calculateReinforcements(state, player.id);
  state.armiesRemaining = r.total;
  log(state, 'phase', `${player.name}'s reinforce phase — ${r.total} armies (${r.base} base + ${r.contBonus} continents)`);
}

function endReinforce(state) {
  if (state.armiesRemaining > 0) return false;
  if (mustTradeIn(state)) return false;
  state.phase = PHASE_ATTACK;
  beginAttack(state);
  return true;
}

function beginAttack(state) {
  state.attackSelection      = null;
  state.pendingConquest      = null;
  state.conqueredThisTurn    = false;
  state.attackTradeRequired  = false;
  state.forcedPlacement      = false;
  const player = PLAYERS[state.currentPlayerIndex];
  log(state, 'phase', `${player.name} enters attack phase.`);
}

function endAttack(state) {
  if (state.attackTradeRequired || state.forcedPlacement) return false;
  state.phase = PHASE_FORTIFY;
  state.attackSelection = null;
  state.pendingConquest = null;
  beginFortify(state);
  return true;
}

function beginFortify(state) {
  state.fortifySelection = null;
  state.hasFortified = false;
  const player = PLAYERS[state.currentPlayerIndex];
  log(state, 'phase', `${player.name} enters fortify phase.`);
}

function advanceTurn(state) {
  const totalPlayers = PLAYERS.length;
  const currentIdx = state.currentPlayerIndex;

  for (let step = 1; step <= totalPlayers; step++) {
    const nextIdx = (currentIdx + step) % totalPlayers;
    if (isPlayerAlive(state, PLAYERS[nextIdx].id)) {
      if (nextIdx <= currentIdx) state.round += 1;
      state.currentPlayerIndex = nextIdx;

      state.phase                = PHASE_REINFORCE;
      state.armiesRemaining      = 0;
      state.attackSelection      = null;
      state.pendingConquest      = null;
      state.conqueredThisTurn    = false;
      state.attackTradeRequired  = false;
      state.forcedPlacement      = false;
      state.fortifySelection     = null;
      state.hasFortified         = false;

      beginReinforce(state);
      return true;
    }
  }
  return false;
}

// True if the current player has to trade before proceeding with the current
// phase. Reinforce: at hand ≥ 5. Attack (after elim/draw): at hand ≥ 5.
function mustTradeIn(state) {
  const player = PLAYERS[state.currentPlayerIndex];
  const hand = state.hands[player.id] || [];
  if (state.phase === PHASE_REINFORCE) {
    return hand.length >= MAX_HAND_SIZE_BEFORE_FORCED_TRADE;
  }
  if (state.phase === PHASE_ATTACK && state.attackTradeRequired) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// REINFORCE ACTION (also used for the forced-placement sub-phase)
// ══════════════════════════════════════════════════════════════════════════

function canReinforce(state, territoryId) {
  // Placement is allowed during reinforce phase OR during forced placement in attack phase.
  const inReinforce = state.phase === PHASE_REINFORCE;
  const inForcedPlacement = state.phase === PHASE_ATTACK && state.forcedPlacement;
  if (!inReinforce && !inForcedPlacement) return false;
  if (state.armiesRemaining <= 0) return false;
  if (inReinforce && mustTradeIn(state)) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  const t = state.territories[territoryId];
  if (!t || t.owner !== player.id) return false;
  return true;
}

function applyReinforce(state, territoryId) {
  if (!canReinforce(state, territoryId)) return false;
  state.territories[territoryId].armies += 1;
  state.armiesRemaining -= 1;
  // Exit forced placement when we've placed everything.
  if (state.armiesRemaining === 0 && state.forcedPlacement) {
    state.forcedPlacement = false;
    log(state, 'phase', `${PLAYERS[state.currentPlayerIndex].name} finishes placing armies — attack resumes.`);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE-IN (allowed in reinforce; and in attack when forced)
// ══════════════════════════════════════════════════════════════════════════

function canTradeIn(state, cardIds) {
  const inReinforce = state.phase === PHASE_REINFORCE;
  const inForcedAttackTrade = state.phase === PHASE_ATTACK && state.attackTradeRequired;
  if (!inReinforce && !inForcedAttackTrade) return false;

  const player = PLAYERS[state.currentPlayerIndex];
  const hand = state.hands[player.id] || [];
  if (!Array.isArray(cardIds) || cardIds.length !== 3) return false;
  if (!cardIds.every(id => hand.includes(id))) return false;
  return isValidTradeSet(cardIds);
}

function applyTradeIn(state, cardIds) {
  if (!canTradeIn(state, cardIds)) return 0;
  const player = PLAYERS[state.currentPlayerIndex];

  state.tradeInCount += 1;
  const setValue = tradeSetValue(state.tradeInCount);

  // Per-card +2 bonus: every owned territory in the traded set gets +2 armies.
  const ownedInSet = ownedTerritoriesInSet(cardIds, state.territories, player.id);
  let territoryBonus = 0;
  for (const tid of ownedInSet) {
    state.territories[tid].armies += 2;
    territoryBonus += 2;
    log(state, 'trade', `${player.name} gains +2 armies on ${_terrName(tid)} (owned card in trade).`);
  }

  state.hands[player.id] = state.hands[player.id].filter(id => !cardIds.includes(id));
  state.discardPile.push(...cardIds);
  state.armiesRemaining += setValue;

  log(state, 'trade', `${player.name} trades in ${tradeSetLabel(cardIds)} — +${setValue} armies (set #${state.tradeInCount}).`);

  // Recompute attack-phase forced-trade state after this trade.
  if (state.phase === PHASE_ATTACK) {
    const newHandSize = state.hands[player.id].length;
    if (newHandSize < MAX_HAND_SIZE_BEFORE_FORCED_TRADE) {
      state.attackTradeRequired = false;
    }
    // We just added armies to armiesRemaining — enter forced placement so
    // the player must place them before attacks can resume.
    if (state.armiesRemaining > 0) {
      state.forcedPlacement = true;
    }
  }

  return setValue + territoryBonus;
}

// ══════════════════════════════════════════════════════════════════════════
// ATTACK SELECTION
// ══════════════════════════════════════════════════════════════════════════

function _attackBlockedByForcedTrade(state) {
  return state.attackTradeRequired || state.forcedPlacement;
}

function canSelectAsAttacker(state, territoryId) {
  if (state.phase !== PHASE_ATTACK) return false;
  if (state.pendingConquest) return false;
  if (_attackBlockedByForcedTrade(state)) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  const t = state.territories[territoryId];
  if (!t || t.owner !== player.id) return false;
  if (t.armies < 2) return false;
  const terr = TERRITORIES[territoryId];
  if (!terr) return false;
  return terr.adjacent.some(nid => state.territories[nid] && state.territories[nid].owner !== player.id);
}

function selectAttacker(state, territoryId) {
  if (!canSelectAsAttacker(state, territoryId)) return false;
  state.attackSelection = { attackerId: territoryId };
  return true;
}

function clearAttacker(state) { state.attackSelection = null; }

function canAttack(state, attackerId, defenderId) {
  if (state.phase !== PHASE_ATTACK) return false;
  if (state.pendingConquest) return false;
  if (_attackBlockedByForcedTrade(state)) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  const a = state.territories[attackerId];
  const d = state.territories[defenderId];
  if (!a || !d) return false;
  if (a.owner !== player.id) return false;
  if (d.owner === player.id) return false;
  if (a.armies < 2) return false;
  const aTerr = TERRITORIES[attackerId];
  if (!aTerr) return false;
  return aTerr.adjacent.includes(defenderId);
}

function getLegalDefenders(state, attackerId) {
  const aTerr = TERRITORIES[attackerId];
  if (!aTerr) return [];
  const player = PLAYERS[state.currentPlayerIndex];
  return aTerr.adjacent.filter(nid => {
    const t = state.territories[nid];
    return t && t.owner !== player.id;
  });
}

// ══════════════════════════════════════════════════════════════════════════
// DICE
// ══════════════════════════════════════════════════════════════════════════

function getMaxAttackerDice(state, attackerId) {
  const a = state.territories[attackerId];
  if (!a) return 0;
  return Math.max(1, Math.min(3, a.armies - 1));
}

function getMaxDefenderDice(state, defenderId) {
  const d = state.territories[defenderId];
  if (!d) return 0;
  return Math.max(1, Math.min(2, d.armies));
}

function rollDice(count) {
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * 6));
  rolls.sort((a, b) => b - a);
  return rolls;
}

function resolveBattleRolls(aRolls, dRolls) {
  let aLoss = 0, dLoss = 0;
  const pairs = Math.min(aRolls.length, dRolls.length);
  for (let i = 0; i < pairs; i++) {
    if (aRolls[i] > dRolls[i]) dLoss++;
    else aLoss++;
  }
  return { attackerLosses: aLoss, defenderLosses: dLoss };
}

function performBattle(state, attackerId, defenderId, requestedAttackerDice) {
  if (!canAttack(state, attackerId, defenderId)) return null;
  const a = state.territories[attackerId];
  const d = state.territories[defenderId];

  const maxA = getMaxAttackerDice(state, attackerId);
  const maxD = getMaxDefenderDice(state, defenderId);
  const aDice = Math.max(1, Math.min(requestedAttackerDice || maxA, maxA));
  const dDice = maxD;

  const aRolls = rollDice(aDice);
  const dRolls = rollDice(dDice);
  const { attackerLosses, defenderLosses } = resolveBattleRolls(aRolls, dRolls);

  a.armies -= attackerLosses;
  d.armies -= defenderLosses;

  const conquered   = d.armies <= 0;
  const mustRetreat = !conquered && a.armies < 2;

  log(state, 'attack',
    `${_terrName(attackerId)} attacks ${_terrName(defenderId)} — attacker rolls [${aRolls.join(', ')}], defender rolls [${dRolls.join(', ')}]. ` +
    `Losses: attacker −${attackerLosses}, defender −${defenderLosses}.`);

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
}

// ══════════════════════════════════════════════════════════════════════════
// APPLY CONQUEST
// ══════════════════════════════════════════════════════════════════════════

function applyConquest(state, armiesToMove) {
  const pc = state.pendingConquest;
  if (!pc) return false;

  const a = state.territories[pc.attackerId];
  const d = state.territories[pc.defenderId];
  if (!a || !d) return false;

  const min = pc.minMove;
  const max = Math.max(min, Math.min(pc.maxMove, a.armies - 1));
  const n = Math.max(min, Math.min(armiesToMove, max));

  const priorOwner = d.owner;

  d.owner = a.owner;
  d.armies = n;
  a.armies -= n;

  log(state, 'conquest',
    `${PLAYERS[state.currentPlayerIndex].name} moves ${n} armies into ${_terrName(pc.defenderId)}.`);

  // Draw a card on first conquest of this turn
  if (!state.conqueredThisTurn) {
    const drawnId = drawCard(state.deck, state.discardPile);
    if (drawnId) {
      const player = PLAYERS[state.currentPlayerIndex];
      if (!state.hands[player.id]) state.hands[player.id] = [];
      state.hands[player.id].push(drawnId);
      log(state, 'conquest', `${player.name} draws a card.`);
    }
    state.conqueredThisTurn = true;
  }

  // Elimination check
  if (countTerritories(state, priorOwner) === 0) {
    const attackerPlayer = PLAYERS.find(p => p.id === a.owner);
    const eliminatedPlayer = PLAYERS.find(p => p.id === priorOwner);
    transferCards(state, priorOwner, a.owner);
    log(state, 'elimination',
      `${eliminatedPlayer.name} has been eliminated! ${attackerPlayer.name} takes their cards.`);
  }

  state.pendingConquest = null;
  if (a.armies < 2) state.attackSelection = null;

  // ── Forced re-trade check ──────────────────────────────────────────
  // After acquiring cards (conquest draw and/or elimination transfer),
  // if the attacker's hand is ≥ 5 during the attack phase, they must
  // trade in a set before doing anything else.
  const currentPlayer = PLAYERS[state.currentPlayerIndex];
  const handSize = (state.hands[currentPlayer.id] || []).length;
  if (state.phase === PHASE_ATTACK && handSize >= MAX_HAND_SIZE_BEFORE_FORCED_TRADE) {
    state.attackTradeRequired = true;
    log(state, 'trade',
      `${currentPlayer.name} must trade in a set (${handSize} cards) before continuing.`);
  }

  // Game over?
  const winner = checkGameOver(state);
  if (winner) {
    state.winner = winner;
    state.phase = PHASE_GAMEOVER;
    log(state, 'gameover', `🏆 ${PLAYERS.find(p => p.id === winner).name} conquers the world!`);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// FORTIFY
// ══════════════════════════════════════════════════════════════════════════

function canSelectAsFortifySource(state, territoryId) {
  if (state.phase !== PHASE_FORTIFY) return false;
  if (state.hasFortified) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  const t = state.territories[territoryId];
  if (!t || t.owner !== player.id) return false;
  if (t.armies < 2) return false;
  return getConnectedOwnTerritories(state, territoryId, player.id).length > 0;
}

function selectFortifySource(state, territoryId) {
  if (!canSelectAsFortifySource(state, territoryId)) return false;
  state.fortifySelection = { sourceId: territoryId };
  return true;
}

function clearFortifySource(state) { state.fortifySelection = null; }

function getConnectedOwnTerritories(state, sourceId, playerId) {
  const source = state.territories[sourceId];
  if (!source || source.owner !== playerId) return [];

  const visited = new Set([sourceId]);
  const queue = [sourceId];
  const result = [];

  while (queue.length > 0) {
    const cur = queue.shift();
    const terr = TERRITORIES[cur];
    if (!terr) continue;
    for (const nid of terr.adjacent) {
      if (visited.has(nid)) continue;
      const n = state.territories[nid];
      if (!n || n.owner !== playerId) continue;
      visited.add(nid);
      queue.push(nid);
      result.push(nid);
    }
  }
  return result;
}

function canFortify(state, sourceId, destId) {
  if (state.phase !== PHASE_FORTIFY) return false;
  if (state.hasFortified) return false;
  if (sourceId === destId) return false;
  const player = PLAYERS[state.currentPlayerIndex];
  const src = state.territories[sourceId];
  const dst = state.territories[destId];
  if (!src || !dst) return false;
  if (src.owner !== player.id || dst.owner !== player.id) return false;
  if (src.armies < 2) return false;
  const connected = getConnectedOwnTerritories(state, sourceId, player.id);
  return connected.includes(destId);
}

function applyFortify(state, sourceId, destId, armies) {
  if (!canFortify(state, sourceId, destId)) return false;
  const src = state.territories[sourceId];
  const dst = state.territories[destId];
  const max = src.armies - 1;
  const n = Math.max(1, Math.min(armies, max));

  src.armies -= n;
  dst.armies += n;
  state.hasFortified = true;
  state.fortifySelection = null;

  const player = PLAYERS[state.currentPlayerIndex];
  log(state, 'fortify', `${player.name} fortifies: ${n} armies from ${_terrName(sourceId)} to ${_terrName(destId)}.`);
  return true;
}

function skipFortify(state) {
  if (state.phase !== PHASE_FORTIFY) return false;
  state.hasFortified = true;
  state.fortifySelection = null;
  const player = PLAYERS[state.currentPlayerIndex];
  log(state, 'fortify', `${player.name} skipped fortify.`);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ELIMINATION + GAME OVER
// ══════════════════════════════════════════════════════════════════════════

function transferCards(state, fromPlayerId, toPlayerId) {
  const fromHand = state.hands[fromPlayerId] || [];
  if (fromHand.length === 0) return 0;
  if (!state.hands[toPlayerId]) state.hands[toPlayerId] = [];
  state.hands[toPlayerId].push(...fromHand);
  state.hands[fromPlayerId] = [];
  return fromHand.length;
}

function isPlayerAlive(state, playerId) {
  return countTerritories(state, playerId) > 0;
}

function checkGameOver(state) {
  for (const p of PLAYERS) {
    if (countTerritories(state, p.id) === Object.keys(state.territories).length) return p.id;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// LOG + HELPERS
// ══════════════════════════════════════════════════════════════════════════

function log(state, type, text) {
  if (!state.gameLog) state.gameLog = [];
  state.gameLog.unshift({ type, text, round: state.round, phase: state.phase, at: Date.now() });
  if (state.gameLog.length > 300) state.gameLog.length = 300;
}

function _terrName(tid) {
  return (typeof TERRITORIES !== 'undefined' && TERRITORIES[tid]) ? TERRITORIES[tid].name : tid;
}
