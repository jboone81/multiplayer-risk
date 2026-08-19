// main.js — Boot the game and wire the render/save loop.

'use strict';

document.addEventListener('DOMContentLoaded', async () => {

  // ── Figure out which lobby room (if any) sent us here ──────────────────
  const urlParams  = new URLSearchParams(location.search);
  const roomCode   = (urlParams.get('room') || '').toUpperCase() || null;
  const myPlayerId = urlParams.get('pid') || null;

  let socket = null;
  let usingServerSync = false;

  // Applies the host's lobby continent-bonus settings to this browser's own
  // CONTINENTS object (map.js's global, read directly by ui.js for display
  // and by rules.js's reinforcement math). Safe to call with null/undefined
  // — falls back to whatever's already in CONTINENTS (map.js's defaults).
  function applyContinentBonuses(bonuses) {
    if (!bonuses) return;
    for (const [id, bonus] of Object.entries(bonuses)) {
      if (CONTINENTS[id] && Number.isFinite(bonus)) CONTINENTS[id].bonus = bonus;
    }
  }

  // ── Try to join a live, server-synced game ──────────────────────────────
  // joinGame proves to the server "I'm the same player who was in the
  // lobby" using the stable playerId lobby.js passed along in the URL (see
  // lobby.js's gameStarting handler). If this succeeds, the server is the
  // sole source of truth from here on — every action goes through it (see
  // sendGameAction below) instead of mutating GAME_STATE in this browser.
  if (roomCode && myPlayerId && typeof io === 'function') {
    socket = io();
    const joinResult = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      socket.emit('joinGame', { code: roomCode, playerId: myPlayerId }, finish);
      setTimeout(() => finish({ ok: false, error: 'Timed out waiting for server.' }), 8000);
    });

    if (joinResult && joinResult.ok && joinResult.gameState) {
      GAME_STATE = joinResult.gameState;
      PLAYERS    = GAME_STATE.players;
      MY_PLAYER_ID = myPlayerId;
      IS_HOST = !!joinResult.isHost;
      applyContinentBonuses(joinResult.continentBonuses);
      usingServerSync = true;
      console.log('[RISK] Joined live server-synced game as',
        (PLAYERS.find(p => p.id === myPlayerId) || {}).name || myPlayerId, IS_HOST ? '(host)' : '');
    } else {
      console.warn('[RISK] Could not join a live game, falling back to local play:', joinResult && joinResult.error);
      socket.close();
      socket = null;
    }
  }

  // ── Fallback: no live server sync (dev/local play, or the join above
  //    failed) — same behavior this app had before server sync existed. ──
  if (!usingServerSync) {
    let lobbyPlayers    = null;
    let serverGameState = null;
    if (roomCode) {
      try {
        const res = await fetch(`/api/room/${encodeURIComponent(roomCode)}`);
        const data = await res.json();
        if (data && data.ok) {
          if (Array.isArray(data.players) && data.players.length) lobbyPlayers = data.players;
          if (data.gameState) serverGameState = data.gameState;
          applyContinentBonuses(data.continentBonuses);
        } else {
          console.warn('[RISK] Room roster unavailable, falling back to defaults:', data && data.error);
        }
      } catch (err) {
        console.warn('[RISK] Could not reach server for room roster, falling back to defaults.', err);
      }
    }

    const saved = loadState();
    if (saved && saved.room === roomCode && Array.isArray(saved.players) && saved.players.length) {
      PLAYERS    = saved.players;
      GAME_STATE = saved;
      console.log('[RISK] Restored saved game.');
    } else if (serverGameState) {
      GAME_STATE = serverGameState;
      PLAYERS    = serverGameState.players;
      console.log('[RISK] Loaded server-built game state (not live — actions here won\'t reach other players).');
    } else {
      console.warn('[RISK] No server game state available — building one locally (this browser will not match other players\' boards).');
      buildGameState(lobbyPlayers, roomCode);
      if (typeof beginSetup === 'function') beginSetup(GAME_STATE);
    }
  }

  // ── DOM refs ─────────────────────────────────────────────────────────
  const mapSvgEl        = document.getElementById('game-map');
  const playerListEl    = document.getElementById('player-list');
  const continentListEl = document.getElementById('continent-list');
  const logEl           = document.getElementById('game-log');

  if (!mapSvgEl || !playerListEl || !continentListEl || !logEl) {
    console.error('[RISK] Required DOM elements missing.');
    return;
  }

  function renderAll() {
    renderMap(mapSvgEl, TERRITORIES, CONTINENTS, GAME_STATE, PLAYERS);
    renderPlayerList(playerListEl, PLAYERS, GAME_STATE);
    renderContinentList(continentListEl, CONTINENTS, GAME_STATE, PLAYERS);
    updateStatusBar(GAME_STATE, PLAYERS);
    renderPhaseBanner(GAME_STATE);
    renderGameLog(logEl, GAME_STATE);
    renderCardsSummary(GAME_STATE);
    renderHeaderButtons(GAME_STATE);
    if (typeof renderDebugControls === 'function') renderDebugControls(GAME_STATE);
  }

  function dispatch() {
    if (!usingServerSync) saveState(GAME_STATE); // server-synced games live on the server, not localStorage
    renderAll();
  }
  setDispatcher(dispatch);

  // ── Action sending: the one place that decides "network or local" ──────
  // Every mutating action ui.js's interactions trigger (place army, attack,
  // fortify, trade cards, ...) goes through this instead of calling
  // rules.js/setup.js directly. Server-synced: sends it over the socket and
  // waits for the resulting authoritative broadcast before resolving, so
  // GAME_STATE is guaranteed current the moment callers resume. Otherwise:
  // falls back to applying the same rules straight to the local GAME_STATE,
  // exactly like this app worked before server sync existed.
  async function sendGameAction(type, args) {
    const res = usingServerSync
      ? await _sendActionOverNetwork(type, args)
      : _applyActionLocally(type, args);
    if (!res.ok && res.error) console.warn(`[RISK] Action '${type}' rejected:`, res.error);
    return res;
  }

  function _sendActionOverNetwork(type, args) {
    return new Promise((resolve) => {
      let ackResult = null;
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };

      // Resolve once the broadcast reflecting this action arrives — the
      // permanent 'gameState' listener (registered once, below, at boot,
      // so it always runs first) has already updated GAME_STATE by then.
      const onState = () => finish(ackResult || { ok: true });
      socket.once('gameState', onState);

      socket.emit('gameAction', { type, args }, (ack) => {
        ackResult = ack;
        if (!ack || !ack.ok) {
          socket.off('gameState', onState); // rejected — no broadcast is coming
          finish(ack || { ok: false, error: 'No response from server.' });
        }
      });

      const timer = setTimeout(() => {
        socket.off('gameState', onState);
        finish({ ok: false, error: 'Timed out waiting for server.' });
      }, 8000);
    });
  }

  // Local/dev-mode fallback — mirrors gameEngine.js's applyAction() dispatch
  // table exactly, just calling the global rules.js/setup.js functions
  // directly instead of through a vm sandbox (there's no server involved).
  function _applyActionLocally(type, args) {
    args = args || {};
    const state = GAME_STATE;
    const player = PLAYERS[state.currentPlayerIndex];
    let ok = true, error = null, result = null;

    switch (type) {
      case 'placeSetupArmy':
        if (!canPlaceSetupArmy(state, args.territoryId)) { ok = false; error = 'Cannot place an army there.'; break; }
        applySetupArmy(state, args.territoryId);
        log(state, 'setup', `${player.name} places an army on ${TERRITORIES[args.territoryId].name}.`);
        break;

      case 'placeReinforcement':
        if (!canReinforce(state, args.territoryId)) { ok = false; error = 'Cannot reinforce there.'; break; }
        applyReinforce(state, args.territoryId);
        log(state, 'reinforce', `${player.name} places an army on ${TERRITORIES[args.territoryId].name} (${state.armiesRemaining} left).`);
        break;

      case 'tradeIn':
        if (!canTradeIn(state, args.cardIds)) { ok = false; error = 'Invalid trade set.'; break; }
        applyTradeIn(state, args.cardIds);
        break;

      case 'endReinforce':
        if (!endReinforce(state)) { ok = false; error = 'Cannot end reinforce yet.'; }
        break;

      case 'attack':
        if (!canAttack(state, args.attackerId, args.defenderId)) { ok = false; error = 'Illegal attack.'; break; }
        result = performBattle(state, args.attackerId, args.defenderId, args.dice || null);
        if (!result) { ok = false; error = 'Battle could not be resolved.'; }
        break;

      case 'applyConquest':
        if (!state.pendingConquest) { ok = false; error = 'No pending conquest.'; break; }
        applyConquest(state, args.armies);
        break;

      case 'endAttack':
        if (!endAttack(state)) { ok = false; error = 'Cannot end attack yet.'; }
        break;

      case 'fortify':
        if (!canFortify(state, args.sourceId, args.destId)) { ok = false; error = 'Illegal fortify.'; break; }
        applyFortify(state, args.sourceId, args.destId, args.armies);
        advanceTurn(state);
        break;

      case 'skipFortify':
        if (!skipFortify(state)) { ok = false; error = 'Cannot skip fortify now.'; break; }
        advanceTurn(state);
        break;

      default:
        ok = false; error = 'Unknown action: ' + type;
    }

    dispatch();
    return { ok, error, result };
  }

  // Debug actions (auto-setup, simulate, rig combat) go through a separate
  // channel from sendGameAction — they bypass turn ownership entirely,
  // which the server only allows for the room's host. Mirrors
  // _sendActionOverNetwork's "wait for the broadcast, not just the ack"
  // pattern, so GAME_STATE is guaranteed fresh by the time this resolves.
  function sendDebugAction(eventName, payload) {
    return new Promise((resolve) => {
      let ackResult = null;
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      const onState = () => finish(ackResult || { ok: true });
      socket.once('gameState', onState);

      socket.emit(eventName, payload, (ack) => {
        ackResult = ack;
        if (!ack || !ack.ok) {
          socket.off('gameState', onState);
          finish(ack || { ok: false, error: 'No response from server.' });
        }
      });

      const timer = setTimeout(() => {
        socket.off('gameState', onState);
        finish({ ok: false, error: 'Timed out waiting for server.' });
      }, 15000); // simulate can take a little longer than a normal action
    });
  }

  setActionSender(sendGameAction);

  if (usingServerSync) {
    // Every broadcast (from our own actions, or anyone else's) replaces
    // GAME_STATE wholesale with the server's personalized-for-us copy.
    socket.on('gameState', (newState) => {
      GAME_STATE = newState;
      PLAYERS    = newState.players;
      renderAll();
    });
    socket.on('disconnect', () => console.warn('[RISK] Lost connection to the game server.'));
  }

  setupDebugToggle(mapSvgEl);
  wireModalEvents();

  document.getElementById('btn-show-cards')?.addEventListener('click', () => openCardModal(GAME_STATE));

  // Debug tools mutate game state directly, so they need different wiring
  // depending on where that state lives:
  //   - Local/dev play (no live server sync): mutate GAME_STATE in this
  //     browser directly, exactly like before server sync existed.
  //   - Live server-synced game, and this browser is the host: send the
  //     same operations to the server (only the host is allowed to; see
  //     server.js's _requireHostWithActiveGame), which runs them against
  //     the real authoritative state and broadcasts the result to everyone.
  //   - Live server-synced game, not the host: not wired at all — debug.js
  //     also hides the controls for non-hosts, this is belt-and-braces.
  if (!usingServerSync) {
    document.getElementById('btn-debug-autosetup')?.addEventListener('click', () => {
      if (typeof autoCompleteSetup === 'function') autoCompleteSetup(GAME_STATE);
      dispatch();
    });

    document.getElementById('btn-debug-simulate')?.addEventListener('click', () => {
      if (typeof simulateWholeGame === 'function') simulateWholeGame(GAME_STATE);
      dispatch();
      if (GAME_STATE.phase === 'gameover' && GAME_STATE.winner) openGameOverModal(GAME_STATE);
    });

    document.getElementById('debug-always-win-p2')?.addEventListener('change', (e) => {
      if (typeof setAlwaysWinPlayer !== 'function') return;
      if (e.target.checked && PLAYERS[1]) {
        setAlwaysWinPlayer(PLAYERS[1].id);
        log(GAME_STATE, 'system', `Debug: rigged combat on — ${PLAYERS[1].name} always wins.`);
      } else {
        clearAlwaysWinPlayer();
        log(GAME_STATE, 'system', 'Debug: rigged combat off.');
      }
      dispatch();
    });
  } else if (IS_HOST) {
    document.getElementById('btn-debug-autosetup')?.addEventListener('click', async () => {
      const res = await sendDebugAction('debugAutoSetup', {});
      if (!res.ok) alert(res.error || 'Could not auto-place armies.');
    });

    document.getElementById('btn-debug-simulate')?.addEventListener('click', async () => {
      const res = await sendDebugAction('debugSimulate', {});
      if (!res.ok) alert(res.error || 'Could not run the simulation.');
      if (GAME_STATE.phase === 'gameover' && GAME_STATE.winner) openGameOverModal(GAME_STATE);
    });

    document.getElementById('debug-always-win-p2')?.addEventListener('change', async (e) => {
      const targetId = (e.target.checked && PLAYERS[1]) ? PLAYERS[1].id : null;
      const res = await sendDebugAction('debugAlwaysWin', { playerId: targetId });
      if (!res.ok) {
        alert(res.error || 'Could not toggle rigged combat.');
        e.target.checked = !e.target.checked; // revert the checkbox on failure
      }
    });
  }

  document.getElementById('btn-end-phase')?.addEventListener('click', async () => {
    if (GAME_STATE.phase === 'reinforce' && GAME_STATE.armiesRemaining === 0 && !mustTradeIn(GAME_STATE)) {
      const res = await sendGameAction('endReinforce', {});
      if (!res.ok) alert(res.error || 'Could not end reinforce phase.');
    } else if (GAME_STATE.phase === 'attack' &&
               !GAME_STATE.pendingConquest &&
               !GAME_STATE.attackTradeRequired &&
               !GAME_STATE.forcedPlacement) {
      const res = await sendGameAction('endAttack', {});
      if (!res.ok) alert(res.error || 'Could not end attack phase.');
    }
  });

  document.getElementById('btn-skip-fortify')?.addEventListener('click', async () => {
    if (GAME_STATE.phase !== 'fortify') return;
    const res = await sendGameAction('skipFortify', {});
    if (!res.ok) alert(res.error || 'Could not skip fortify.');
  });

  document.getElementById('btn-new-game')?.addEventListener('click', () => {
    if (!confirm('Start a new game? This will clear the saved state.')) return;
    clearState();
    location.reload();
  });

  document.getElementById('btn-gameover-new')?.addEventListener('click', () => {
    clearState();
    location.reload();
  });

  renderAll();

  // Restore mid-flow modals if applicable
  if (GAME_STATE.pendingConquest) openMoveModal(GAME_STATE);
  if (GAME_STATE.phase === 'attack' && GAME_STATE.attackTradeRequired) openCardModal(GAME_STATE);
  if (GAME_STATE.phase === 'gameover' && GAME_STATE.winner) openGameOverModal(GAME_STATE);

  console.log('[RISK] Loaded.', {
    territories:   Object.keys(TERRITORIES).length,
    players:       PLAYERS.length,
    round:         GAME_STATE.round,
    phase:         GAME_STATE.phase,
    currentPlayer: PLAYERS[GAME_STATE.currentPlayerIndex].name,
    liveSync:      usingServerSync,
    storageOk:     isStorageAvailable()
  });
});
