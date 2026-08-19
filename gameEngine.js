// gameEngine.js — Runs the shared game-logic files (map.js, cards.js,
// state.js, rules.js, setup.js) on the server, completely unmodified,
// inside a sandboxed Node `vm` context.
//
// Why: those files are written as classic browser <script> tags that all
// share one global scope — that's how rules.js can reference PLAYERS or
// call log() without importing anything. Node's require() doesn't work
// that way; each required file gets its own isolated module scope, so the
// cross-file references those files rely on would break if we just
// require()'d them directly.
//
// Loading them into a `vm` context instead reproduces that same
// shared-global-scope browser behavior on the server, so all these files
// work completely as-is — no duplicated logic, no risk of the server and
// the browser's copies of the rules drifting apart. debug.js is included
// too (its testing helpers — auto-setup, full-game simulation, rigged
// combat — are handy for the host to run server-side against the real,
// authoritative game). Only its renderDebugControls() touches the DOM, and
// that's never called here. storage.js, ui.js, and main.js are genuinely
// browser-only (DOM/localStorage-dependent throughout) and are NOT loaded.
//
// Each createEngine() call gets its own isolated context/global-scope, so
// a server can safely run one engine per room without any state leaking
// between concurrent games.

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ENGINE_FILES = ['map.js', 'cards.js', 'state.js', 'rules.js', 'setup.js', 'debug.js'];

function createEngine() {
  const sandbox = { console };
  vm.createContext(sandbox);

  for (const file of ENGINE_FILES) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
  }

  function run(expr) {
    return vm.runInContext(expr, sandbox);
  }

  // Calls any top-level function exposed by the loaded files (e.g.
  // 'buildGameState', 'applyReinforce', 'endAttack', ...) with the given
  // arguments, without the caller needing to know this is a vm context.
  function call(fnName, ...args) {
    sandbox.__engineArgs = args;
    try {
      return vm.runInContext(`${fnName}(...__engineArgs)`, sandbox);
    } finally {
      delete sandbox.__engineArgs;
    }
  }

  return {
    // Overrides one or more continents' bonus-army values (host-configured
    // in the lobby) on this engine's own CONTINENTS object, in place. Call
    // this BEFORE buildGame() — reinforcement math (rules.js) reads
    // CONTINENTS[id].bonus live on every turn, so setting it once up front
    // is all that's needed for the rest of the game. Silently ignores
    // unknown continent ids or non-finite values rather than throwing, so a
    // stale/partial overrides object can never crash game start.
    setContinentBonuses(overrides) {
      if (!overrides) return;
      const continents = run('CONTINENTS');
      for (const [id, bonus] of Object.entries(overrides)) {
        if (continents[id] && Number.isFinite(bonus)) {
          continents[id].bonus = bonus;
        }
      }
    },

    // Builds a brand-new game for the given lobby roster and puts it in
    // the setup phase, ready for players to place their starting armies.
    // Returns the resulting GAME_STATE (a plain, JSON-serializable object).
    buildGame(players, roomCode) {
      call('buildGameState', players, roomCode);
      const state = run('GAME_STATE');
      call('beginSetup', state);
      return run('GAME_STATE');
    },

    getState()   { return run('GAME_STATE'); },
    getPlayers() { return run('PLAYERS'); },

    // Generic passthrough for calling any rules.js/setup.js function against
    // this engine's live GAME_STATE, e.g. engine.call('applyReinforce', tid).
    call(fnName, ...args) {
      return call(fnName, run('GAME_STATE'), ...args);
    },

    // The authoritative action gateway. Every turn-changing thing a client
    // wants to do — place an army, attack, fortify, trade cards — comes
    // through here as { type, args }, gets validated with the exact same
    // can*() checks the browser UI uses, and mutates this engine's own
    // GAME_STATE if (and only if) it's legal. Returns { ok, error?, result? }.
    //
    // Every action requires it currently being that player's turn — true
    // for every phase in this game (setup included, since setup.js cycles
    // currentPlayerIndex through everyone in turn), so one blanket check
    // up front covers all of them.
    applyAction(playerId, type, args) {
      args = args || {};
      const state = run('GAME_STATE');
      const players = run('PLAYERS');
      if (!state || !players || !players.length) {
        return { ok: false, error: 'Game not initialized.' };
      }

      const currentPlayer = players[state.currentPlayerIndex];
      if (!currentPlayer || currentPlayer.id !== playerId) {
        return { ok: false, error: "It's not your turn." };
      }

      switch (type) {
        case 'placeSetupArmy': {
          if (!call('canPlaceSetupArmy', state, args.territoryId)) {
            return { ok: false, error: 'Cannot place an army there.' };
          }
          call('applySetupArmy', state, args.territoryId);
          // applySetupArmy() only logs turn-transitions, not the placement
          // itself — the browser UI used to narrate that client-side, so
          // it happens here now that the server is the one mutating state.
          call('log', state, 'setup',
            `${currentPlayer.name} places an army on ${call('_terrName', args.territoryId)}.`);
          return { ok: true };
        }

        case 'placeReinforcement': {
          if (!call('canReinforce', state, args.territoryId)) {
            return { ok: false, error: 'Cannot reinforce there.' };
          }
          call('applyReinforce', state, args.territoryId);
          call('log', state, 'reinforce',
            `${currentPlayer.name} places an army on ${call('_terrName', args.territoryId)} (${state.armiesRemaining} left).`);
          return { ok: true };
        }

        case 'tradeIn': {
          if (!call('canTradeIn', state, args.cardIds)) {
            return { ok: false, error: 'That is not a valid set to trade in.' };
          }
          call('applyTradeIn', state, args.cardIds);
          return { ok: true };
        }

        case 'endReinforce': {
          if (!call('endReinforce', state)) {
            return { ok: false, error: 'Cannot end reinforce yet.' };
          }
          return { ok: true };
        }

        case 'attack': {
          if (!call('canAttack', state, args.attackerId, args.defenderId)) {
            return { ok: false, error: 'Illegal attack.' };
          }
          const result = call('performBattle', state, args.attackerId, args.defenderId, args.dice || null);
          if (!result) return { ok: false, error: 'Battle could not be resolved.' };
          return { ok: true, result };
        }

        case 'applyConquest': {
          if (!state.pendingConquest) return { ok: false, error: 'No conquest pending.' };
          call('applyConquest', state, args.armies);
          return { ok: true };
        }

        case 'endAttack': {
          if (!call('endAttack', state)) {
            return { ok: false, error: 'Cannot end attack yet.' };
          }
          return { ok: true };
        }

        case 'fortify': {
          if (!call('canFortify', state, args.sourceId, args.destId)) {
            return { ok: false, error: 'Illegal fortify.' };
          }
          call('applyFortify', state, args.sourceId, args.destId, args.armies);
          call('advanceTurn', state); // matches the client: a fortify always ends the turn
          return { ok: true };
        }

        case 'skipFortify': {
          if (!call('skipFortify', state)) {
            return { ok: false, error: 'Cannot skip fortify now.' };
          }
          call('advanceTurn', state);
          return { ok: true };
        }

        default:
          return { ok: false, error: `Unknown action type: ${type}` };
      }
    },

    // ── Debug/testing operations — callers (server.js) must restrict these
    //    to the room's host. They mutate this engine's real, authoritative
    //    GAME_STATE directly (no turn-ownership check — that's the point,
    //    they're for setting up test scenarios quickly).
    debugAutoCompleteSetup() {
      const state = run('GAME_STATE');
      call('autoCompleteSetup', state);
      return run('GAME_STATE');
    },

    debugSimulateWholeGame(options) {
      const state = run('GAME_STATE');
      call('simulateWholeGame', state, options || undefined);
      return run('GAME_STATE');
    },

    debugSetAlwaysWinPlayer(playerId) {
      call('setAlwaysWinPlayer', playerId);
      return true;
    },

    debugClearAlwaysWinPlayer() {
      call('clearAlwaysWinPlayer');
      return true;
    },

    debugGetAlwaysWinPlayer() {
      return call('getAlwaysWinPlayer');
    }
  };
}

module.exports = { createEngine };
