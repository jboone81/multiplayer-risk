// ui.js — SVG rendering, panel rendering, interaction handlers.
// No game logic — mutations happen through rules.js.

'use strict';

// ── Config ────────────────────────────────────────────────────────────────
const MAP_IMAGE_PATH = 'assets/risk-map.png';
const IMAGE_WIDTH  = 800;
const IMAGE_HEIGHT = 533;

const NODE_RADIUS       = 12;
const NODE_HOVER_RADIUS = 14;
const HIT_RADIUS        = 18;

const BLITZ_ROLL_DELAY_MS = 380;   // pace between blitz rolls (animated)

// ── Dispatcher (set by main.js) ────────────────────────────────────────────
let _dispatch = () => {};
function setDispatcher(fn) { _dispatch = fn; }

// ── Action sender (set by main.js) ──────────────────────────────────────────
// The one path every mutating interaction goes through — main.js wires this
// to either send the action to the server (live multiplayer) or apply it
// straight to the local GAME_STATE (dev/local play). Always async: even the
// local path returns a resolved promise, so callers here don't need two
// different code paths. Returns { ok, error?, result? }.
let _sendAction = async () => ({ ok: false, error: 'No action sender configured.' });
function setActionSender(fn) { _sendAction = fn; }

// Identity of the player THIS browser is (set by main.js after the
// joinGame handshake). Null in local/dev play, where there's no real
// per-player identity and the old hot-seat-style behavior applies.
let MY_PLAYER_ID = null;

// True if this browser is the room's host (set by main.js after the
// joinGame handshake). Only the host may use the server-side debug tools
// in a live game — see debug.js's renderDebugControls().
let IS_HOST = false;

// ── UI-only state ──────────────────────────────────────────────────────────
let _selectedCards = [];
let _combatCtx = null;      // { attackerId, defenderId, chosenDice, lastResult, blitzActive }

// ── SVG helper ─────────────────────────────────────────────────────────────
function createSVGEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
  return el;
}

// ══════════════════════════════════════════════════════════════════════════
// MAP RENDER
// ══════════════════════════════════════════════════════════════════════════

// Territory count/positions are static once the board's built — only
// ownership, army counts, and selection highlighting actually change from
// render to render. So the 42 SVG nodes (and their event listeners) get
// built exactly once per svgEl and cached here; every subsequent renderMap
// call just patches the handful of attributes that actually differ instead
// of tearing down and recreating the whole map (with fresh listeners) on
// every single reinforce click, dice roll, or fortify.
let _mapRenderCache = null; // { svgEl, nodes: { [territoryId]: { g, circle, armyText, hit, debugLabel } } }

function renderMap(svgEl, territories, continents, gameState, players) {
  if (!_mapRenderCache || _mapRenderCache.svgEl !== svgEl) {
    _buildMapNodes(svgEl, territories);
  }
  const nodes = _mapRenderCache.nodes;

  const currentPlayer = players[gameState.currentPlayerIndex];
  const inReinforceGlow =
    (gameState.phase === 'setup') ||
    (gameState.phase === 'reinforce' && gameState.armiesRemaining > 0 && !mustTradeIn(gameState)) ||
    (gameState.phase === 'attack' && gameState.forcedPlacement && gameState.armiesRemaining > 0);
  const inAttack  = gameState.phase === 'attack' && !gameState.pendingConquest &&
                    !gameState.attackTradeRequired && !gameState.forcedPlacement;
  const inFortify = gameState.phase === 'fortify' && !gameState.hasFortified;

  const attackerId  = inAttack && gameState.attackSelection ? gameState.attackSelection.attackerId : null;
  const legalDefenders = attackerId ? new Set(getLegalDefenders(gameState, attackerId)) : new Set();

  const fortifySourceId = inFortify && gameState.fortifySelection ? gameState.fortifySelection.sourceId : null;
  const fortifyDests    = fortifySourceId ? new Set(getConnectedOwnTerritories(gameState, fortifySourceId, currentPlayer.id)) : new Set();

  for (const [id, terr] of Object.entries(territories)) {
    const tState = gameState.territories[id];
    const player = players.find(p => p.id === tState.owner);
    const { g, circle, armyText } = nodes[id];

    const classes = ['territory-node'];
    if (inReinforceGlow && tState.owner === currentPlayer.id) classes.push('reinforceable');
    if (inAttack && !attackerId && canSelectAsAttacker(gameState, id)) classes.push('attackable');
    if (id === attackerId) classes.push('attacker-selected');
    if (legalDefenders.has(id)) classes.push('legal-target');
    if (inFortify && !fortifySourceId && canSelectAsFortifySource(gameState, id)) classes.push('fortify-source-available');
    if (id === fortifySourceId) classes.push('fortify-source-selected');
    if (fortifyDests.has(id)) classes.push('fortify-dest');

    g.setAttribute('class', classes.join(' '));
    g.setAttribute('data-owner', tState.owner);
    g.setAttribute('aria-label', `${terr.name}: ${tState.armies} armies, owned by ${player.name}`);
    circle.setAttribute('fill', player.color);
    circle.setAttribute('stroke', player.darkColor);
    armyText.textContent = tState.armies;
  }
}

function _buildMapNodes(svgEl, territories) {
  svgEl.innerHTML = '';

  const defs = createSVGEl('defs');
  const shadowFilter = createSVGEl('filter', {
    id: 'node-shadow', x: '-60%', y: '-60%', width: '220%', height: '220%'
  });
  shadowFilter.appendChild(createSVGEl('feDropShadow', {
    dx: '0', dy: '2', stdDeviation: '2.5', 'flood-color': 'rgba(0,0,0,0.55)'
  }));
  defs.appendChild(shadowFilter);
  svgEl.appendChild(defs);

  const bgImage = createSVGEl('image', {
    x: 0, y: 0, width: IMAGE_WIDTH, height: IMAGE_HEIGHT,
    href: MAP_IMAGE_PATH, preserveAspectRatio: 'none'
  });
  bgImage.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', MAP_IMAGE_PATH);
  svgEl.appendChild(bgImage);

  const nodesGroup = createSVGEl('g', { class: 'territory-nodes' });
  const nodes = {};

  for (const [id, terr] of Object.entries(territories)) {
    // class/data-owner/aria-label are set for real by renderMap's per-render
    // update loop right after this function returns — no need to compute
    // accurate values for them here.
    const g = createSVGEl('g', {
      'data-id': id, 'data-continent': terr.continent,
      tabindex: '0', role: 'button'
    });
    g.style.cursor = 'pointer';

    const hit = createSVGEl('circle', {
      class: 'territory-hit',
      cx: terr.x, cy: terr.y, r: HIT_RADIUS,
      fill: 'transparent', stroke: 'transparent', 'stroke-width': '1.5'
    });

    const circle = createSVGEl('circle', {
      class: 'territory-circle',
      cx: terr.x, cy: terr.y, r: NODE_RADIUS,
      'stroke-width': '2',
      filter: 'url(#node-shadow)'
    });

    const armyText = createSVGEl('text', {
      class: 'territory-armies',
      x: terr.x, y: terr.y + 4, 'text-anchor': 'middle',
      fill: '#ffffff', 'font-size': '11', 'font-weight': '700',
      'font-family': 'Inter, system-ui, sans-serif',
      'pointer-events': 'none',
      'paint-order': 'stroke', stroke: 'rgba(0,0,0,0.55)', 'stroke-width': '0.5'
    });

    const debugLabel = createSVGEl('text', {
      class: 'territory-debug-label',
      x: terr.x, y: terr.y - HIT_RADIUS - 3, 'text-anchor': 'middle',
      'font-size': '8', 'font-family': 'ui-monospace, monospace',
      fill: '#ffff00', stroke: '#000', 'stroke-width': '0.4',
      'paint-order': 'stroke', 'pointer-events': 'none'
    });
    debugLabel.textContent = id;

    g.appendChild(hit);
    g.appendChild(circle);
    g.appendChild(armyText);
    g.appendChild(debugLabel);

    _attachTerritoryInteractions(g, svgEl, id, terr, { circle, armyText, hit, debugLabel });

    nodesGroup.appendChild(g);
    nodes[id] = { g, circle, armyText, hit, debugLabel };
  }
  svgEl.appendChild(nodesGroup);

  _mapRenderCache = { svgEl, nodes };
}

// ══════════════════════════════════════════════════════════════════════════
// TERRITORY INTERACTIONS
// ══════════════════════════════════════════════════════════════════════════

// Attached exactly once per node (see _buildMapNodes above), so this never
// runs again while a game is in progress — everything it needs at click
// time is read live off the global GAME_STATE/PLAYERS rather than captured
// in a closure, so it stays correct no matter how many renders have
// happened since this listener was attached.
function _attachTerritoryInteractions(g, svgEl, id, terr, parts) {
  const { circle, armyText, hit, debugLabel } = parts;

  // Drag-to-tune (debug only)
  let dragging = false, moved = false, startClient = null;
  const svgPoint = svgEl.createSVGPoint ? svgEl.createSVGPoint() : null;

  function clientToSvg(evt) {
    if (!svgPoint) return null;
    svgPoint.x = evt.clientX; svgPoint.y = evt.clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return null;
    const p = svgPoint.matrixTransform(ctm.inverse());
    return {
      x: Math.max(0, Math.min(IMAGE_WIDTH,  Math.round(p.x))),
      y: Math.max(0, Math.min(IMAGE_HEIGHT, Math.round(p.y)))
    };
  }
  function moveTo(x, y) {
    terr.x = x; terr.y = y;
    hit.setAttribute('cx', x); hit.setAttribute('cy', y);
    circle.setAttribute('cx', x); circle.setAttribute('cy', y);
    armyText.setAttribute('x', x); armyText.setAttribute('y', y + 4);
    debugLabel.setAttribute('x', x); debugLabel.setAttribute('y', y - HIT_RADIUS - 3);
  }

  g.addEventListener('mousedown', (e) => {
    if (!svgEl.classList.contains('debug')) return;
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startClient = { x: e.clientX, y: e.clientY };
    g.style.cursor = 'grabbing';
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (!moved) {
      const dx = e.clientX - startClient.x;
      const dy = e.clientY - startClient.y;
      if (dx * dx + dy * dy < 9) return;
      moved = true;
    }
    const p = clientToSvg(e);
    if (p) moveTo(p.x, p.y);
  });
  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    g.style.cursor = 'pointer';
    if (moved) {
      console.log(`[TUNE] ${id}: { x: ${terr.x}, y: ${terr.y} },`);
      e.preventDefault(); e.stopPropagation();
    }
  });

  // Click behavior
  g.addEventListener('click', (e) => {
    if (moved) { e.stopPropagation(); moved = false; return; }
    if (typeof GAME_STATE === 'undefined') return;

    // In a live server-synced game, ignore clicks entirely when it isn't
    // this browser's turn — the server would reject the action anyway, but
    // this avoids a pointless round trip and, more importantly, stops one
    // player from acting on another's turn in their own local render.
    if (MY_PLAYER_ID && PLAYERS[GAME_STATE.currentPlayerIndex].id !== MY_PLAYER_ID) return;

    // Setup phase — players place their leftover starting armies by hand.
    if (GAME_STATE.phase === 'setup') {
      if (canPlaceSetupArmy(GAME_STATE, id)) _sendAction('placeSetupArmy', { territoryId: id });
      return;
    }

    // Reinforce phase OR forced placement during attack
    if (GAME_STATE.phase === 'reinforce' ||
        (GAME_STATE.phase === 'attack' && GAME_STATE.forcedPlacement)) {
      if (canReinforce(GAME_STATE, id)) _sendAction('placeReinforcement', { territoryId: id });
      return;
    }

    // Attack phase (normal, no forced trade / placement in progress)
    if (GAME_STATE.phase === 'attack' && !GAME_STATE.pendingConquest &&
        !GAME_STATE.attackTradeRequired && !GAME_STATE.forcedPlacement) {
      const sel = GAME_STATE.attackSelection;
      if (!sel) {
        if (canSelectAsAttacker(GAME_STATE, id)) {
          selectAttacker(GAME_STATE, id);
          _dispatch();
        }
        return;
      }
      if (sel.attackerId === id) { clearAttacker(GAME_STATE); _dispatch(); return; }
      if (canAttack(GAME_STATE, sel.attackerId, id)) {
        openCombatModal(GAME_STATE, sel.attackerId, id);
        return;
      }
      if (canSelectAsAttacker(GAME_STATE, id)) {
        selectAttacker(GAME_STATE, id);
        _dispatch();
        return;
      }
      return;
    }

    // Fortify phase
    if (GAME_STATE.phase === 'fortify' && !GAME_STATE.hasFortified) {
      const sel = GAME_STATE.fortifySelection;
      if (!sel) {
        if (canSelectAsFortifySource(GAME_STATE, id)) {
          selectFortifySource(GAME_STATE, id);
          _dispatch();
        }
        return;
      }
      if (sel.sourceId === id) { clearFortifySource(GAME_STATE); _dispatch(); return; }
      if (canFortify(GAME_STATE, sel.sourceId, id)) {
        openFortifyModal(GAME_STATE, sel.sourceId, id);
        return;
      }
      if (canSelectAsFortifySource(GAME_STATE, id)) {
        selectFortifySource(GAME_STATE, id);
        _dispatch();
        return;
      }
      return;
    }

    // Fallback: log territory info — read live rather than from a stale
    // closure, since this listener is attached once and never rebuilt.
    const liveTState = GAME_STATE.territories[id];
    const livePlayer = PLAYERS.find(p => p.id === liveTState.owner);
    console.log(`[RISK] Territory: "${id}"`, {
      id, name: terr.name, continent: terr.continent, adjacent: terr.adjacent,
      owner: liveTState.owner, armies: liveTState.armies, player: livePlayer && livePlayer.name
    });
  });

  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      g.dispatchEvent(new MouseEvent('click'));
    }
  });

  g.addEventListener('mouseenter', () => circle.setAttribute('r', NODE_HOVER_RADIUS));
  g.addEventListener('mouseleave', () => circle.setAttribute('r', NODE_RADIUS));
}

// ══════════════════════════════════════════════════════════════════════════
// DEBUG OVERLAY
// ══════════════════════════════════════════════════════════════════════════

function setupDebugToggle(svgEl) {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'd' || e.key === 'D') {
      svgEl.classList.toggle('debug');
      const on = svgEl.classList.contains('debug');
      console.log(`[RISK] Debug overlay: ${on ? 'ON' : 'OFF'}`);
    }
    if ((e.key === 'x' || e.key === 'X') && svgEl.classList.contains('debug')) _dumpCoords();
  });
}
function _dumpCoords() {
  if (typeof TERRITORIES === 'undefined') return;
  const lines = ['/* ── Paste these into map.js ── */'];
  for (const [id, t] of Object.entries(TERRITORIES)) lines.push(`  ${id}: { x: ${t.x}, y: ${t.y} },`);
  console.log(lines.join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════
// SIDEBAR PANELS
// ══════════════════════════════════════════════════════════════════════════

function renderPlayerList(containerEl, players, gameState) {
  const stats = {};
  players.forEach(p => { stats[p.id] = { territories: 0, armies: 0 }; });
  Object.values(gameState.territories).forEach(t => {
    stats[t.owner].territories += 1;
    stats[t.owner].armies      += t.armies;
  });

  containerEl.innerHTML = '';
  players.forEach((player, index) => {
    const isActive = (index === gameState.currentPlayerIndex);
    const alive = stats[player.id].territories > 0;
    const card = document.createElement('div');
    card.className = `player-card${isActive ? ' active' : ''}`;
    if (!alive) card.style.opacity = '0.35';
    card.innerHTML = `
      <div class="player-color-dot" style="background:${player.color}; box-shadow:0 0 9px ${player.color}99;"></div>
      <div class="player-info">
        <div class="player-name">
          ${player.name}
          ${isActive ? '<span class="turn-badge">TURN</span>' : ''}
        </div>
        <div class="player-stats">
          <span>${stats[player.id].territories} territories</span>
          <span class="dot-sep">·</span>
          <span>${stats[player.id].armies} armies</span>
          ${gameState.phase === 'setup' && setupArmiesLeft(gameState, player.id) > 0
            ? `<span class="dot-sep">·</span><span>${setupArmiesLeft(gameState, player.id)} to place</span>`
            : ''}
        </div>
      </div>`;
    containerEl.appendChild(card);
  });
}

function renderContinentList(containerEl, continents, gameState, players) {
  containerEl.innerHTML = '';
  for (const cont of Object.values(continents)) {
    const total = cont.territories.length;
    const ownerCounts = {};
    cont.territories.forEach(tid => {
      const ownerId = gameState.territories[tid]?.owner;
      if (ownerId) ownerCounts[ownerId] = (ownerCounts[ownerId] || 0) + 1;
    });
    const controllerEntry = Object.entries(ownerCounts).find(([, c]) => c === total);
    let controllerHTML = '';
    if (controllerEntry) {
      const controller = players.find(p => p.id === controllerEntry[0]);
      controllerHTML = `<span class="continent-controlled" style="color:${controller.color}">★</span>`;
    }
    const item = document.createElement('div');
    item.className = 'continent-item';
    item.innerHTML = `
      <span class="continent-name">${cont.name}</span>
      <span class="continent-bonus">+${cont.bonus} ${controllerHTML}</span>`;
    containerEl.appendChild(item);
  }
}

function updateStatusBar(gameState, players) {
  const currentPlayer = players[gameState.currentPlayerIndex];
  const phaseEl = document.getElementById('phase-display');
  const roundEl = document.getElementById('round-display');
  const turnEl  = document.getElementById('turn-display');
  if (roundEl) roundEl.textContent = gameState.round;
  if (phaseEl) phaseEl.textContent = _capitalise(gameState.phase);
  if (turnEl) {
    turnEl.textContent = currentPlayer.name;
    turnEl.style.color = currentPlayer.color;
    turnEl.style.textShadow = `0 0 12px ${currentPlayer.color}88`;
  }
}
function _capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

// ══════════════════════════════════════════════════════════════════════════
// PHASE BANNER
// ══════════════════════════════════════════════════════════════════════════

function renderPhaseBanner(gameState) {
  const banner = document.getElementById('phase-banner');
  const labelEl = document.getElementById('phase-banner-label');
  const detailEl = document.getElementById('phase-banner-detail');
  if (!banner || !labelEl || !detailEl) return;
  const player = PLAYERS[gameState.currentPlayerIndex];

  if (gameState.phase === 'setup') {
    banner.classList.remove('hidden');
    labelEl.textContent = `${player.name} — Place Armies`;
    detailEl.textContent = `${setupArmiesLeft(gameState, player.id)} armies left to place on your territories.`;
  } else if (gameState.phase === 'reinforce') {
    banner.classList.remove('hidden');
    labelEl.textContent = `${player.name} — Reinforce`;
    if (mustTradeIn(gameState)) {
      detailEl.textContent = 'Trade in a set to continue.';
    } else if (gameState.armiesRemaining > 0) {
      detailEl.textContent = `${gameState.armiesRemaining} armies to place`;
    } else {
      detailEl.textContent = 'All armies placed — end phase to attack.';
    }
  } else if (gameState.phase === 'attack') {
    banner.classList.remove('hidden');
    if (gameState.attackTradeRequired) {
      labelEl.textContent = `${player.name} — Attack (forced trade)`;
      detailEl.textContent = 'Hand ≥ 5 — trade in a set before continuing.';
    } else if (gameState.forcedPlacement) {
      labelEl.textContent = `${player.name} — Attack (placement)`;
      detailEl.textContent = `Place ${gameState.armiesRemaining} armies to resume attacking.`;
    } else {
      labelEl.textContent = `${player.name} — Attack`;
      if (gameState.attackSelection) {
        detailEl.textContent = `Click a yellow-glowing enemy neighbor of ${TERRITORIES[gameState.attackSelection.attackerId].name}.`;
      } else {
        detailEl.textContent = 'Click a red-glowing territory to attack from.';
      }
    }
  } else if (gameState.phase === 'fortify') {
    banner.classList.remove('hidden');
    labelEl.textContent = `${player.name} — Fortify`;
    if (gameState.fortifySelection) {
      detailEl.textContent = `Click any cyan destination connected to ${TERRITORIES[gameState.fortifySelection.sourceId].name}.`;
    } else {
      detailEl.textContent = 'Click a cyan-glowing territory to move armies from, or Skip Fortify.';
    }
  } else {
    banner.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GAME LOG
// ══════════════════════════════════════════════════════════════════════════

// Mirrors what's currently rendered in containerEl, top-to-bottom (newest
// first, matching gameState.gameLog's own order — see rules.js's log(),
// which unshifts new entries onto the front and caps at 300). Used so
// repeat renders can patch in just the new lines instead of rebuilding the
// whole log — which used to happen on literally every single game action,
// and got more expensive as a game went on and the log filled up.
let _logRenderCache = null; // { containerEl, entries: [{at, text}, ...] }

// Past this many new/evicted entries in one render, it's cheaper to just
// rebuild than to search for where the old and new logs realign — covers
// bulk operations like the debug "simulate whole game" tool, which can
// generate hundreds of log lines in a single broadcast.
const LOG_INCREMENTAL_SEARCH_LIMIT = 50;

function _buildLogEntryNode(entry) {
  const div = document.createElement('div');
  div.className = `log-entry log-${entry.type || 'system'}`;
  const meta = document.createElement('div');
  meta.className = 'log-meta';
  meta.textContent = `R${entry.round || '?'} · ${entry.phase || ''}`;
  const text = document.createElement('div');
  text.textContent = entry.text;
  div.appendChild(meta);
  div.appendChild(text);
  return div;
}

// `at` (set once, when rules.js's log() first creates the entry) plus
// `text` is a stable-enough fingerprint for a specific log entry even
// though every network broadcast re-clones the whole array into fresh
// object instances — the values themselves don't change, only the wrapper.
function _logEntriesEqual(a, b) {
  return a.at === b.at && a.text === b.text;
}

function renderGameLog(containerEl, gameState) {
  const log = gameState.gameLog || [];
  const cache = _logRenderCache;
  const sameContainer = !!cache && cache.containerEl === containerEl;

  // Fast path: nothing changed since last render (most re-renders are
  // triggered by something other than a new log line) — skip entirely.
  if (sameContainer && cache.entries.length === log.length &&
      (log.length === 0 || _logEntriesEqual(cache.entries[0], log[0]))) {
    return;
  }

  // Try to reconcile incrementally: find a k (new entries prepended) and
  // matching eviction count such that log[k..] lines up exactly with what's
  // already rendered (minus anything trimmed off the tail by the 300 cap).
  // If found, just prepend the k new nodes and drop the evicted ones rather
  // than tearing down and rebuilding every entry.
  if (sameContainer) {
    const maxPrepend = Math.min(log.length, LOG_INCREMENTAL_SEARCH_LIMIT);
    for (let k = 0; k <= maxPrepend; k++) {
      const evicted = cache.entries.length + k - log.length;
      if (evicted < 0 || evicted > cache.entries.length) continue;
      const compareLen = cache.entries.length - evicted;

      let aligned = true;
      for (let i = 0; i < compareLen; i++) {
        if (!_logEntriesEqual(log[k + i], cache.entries[i])) { aligned = false; break; }
      }
      if (!aligned) continue;

      for (let i = k - 1; i >= 0; i--) {
        containerEl.insertBefore(_buildLogEntryNode(log[i]), containerEl.firstChild);
      }
      for (let i = 0; i < evicted; i++) {
        if (containerEl.lastChild) containerEl.removeChild(containerEl.lastChild);
      }
      _logRenderCache = { containerEl, entries: log.map(e => ({ at: e.at, text: e.text })) };
      return;
    }
  }

  // Fallback: full rebuild (first render, container swapped, or no
  // alignment found within the search limit above).
  containerEl.innerHTML = '';
  for (const entry of log) containerEl.appendChild(_buildLogEntryNode(entry));
  _logRenderCache = { containerEl, entries: log.map(e => ({ at: e.at, text: e.text })) };
}

// ══════════════════════════════════════════════════════════════════════════
// CARDS PANEL (sidebar)
// ══════════════════════════════════════════════════════════════════════════

// The player whose cards should be shown: in a live server-synced game
// that's always the viewer's own identity (you can check your hand any
// time, not just on your turn) — in local/hot-seat play there's no real
// per-viewer identity, so it falls back to whoever's turn it is, matching
// how this always worked before.
function _viewedPlayer(gameState) {
  if (MY_PLAYER_ID) {
    const me = PLAYERS.find(p => p.id === MY_PLAYER_ID);
    if (me) return me;
  }
  return PLAYERS[gameState.currentPlayerIndex];
}

function renderCardsSummary(gameState) {
  const summary = document.getElementById('cards-summary');
  const notice  = document.getElementById('cards-forced-notice');
  const btn     = document.getElementById('btn-show-cards');
  if (!summary || !notice || !btn) return;
  const player = _viewedPlayer(gameState);
  const hand   = gameState.hands[player.id] || [];
  summary.textContent = `View hand (${hand.length})`;
  btn.disabled = false;

  // A forced-trade obligation only ever applies to whoever's turn it
  // actually is — mustTradeIn()/attackTradeRequired are both about the
  // current player, so only show the urgent notice when that's also who
  // we're viewing (i.e. it's my own turn, or we're in local hot-seat play).
  const isMyTurn = player.id === PLAYERS[gameState.currentPlayerIndex].id;
  const forcedReinforce = isMyTurn && gameState.phase === 'reinforce' && mustTradeIn(gameState);
  const forcedAttack    = isMyTurn && gameState.phase === 'attack'    && gameState.attackTradeRequired;

  if (forcedReinforce) {
    notice.classList.remove('hidden');
    notice.textContent = `You have ${hand.length} cards — trade a set before placing armies.`;
  } else if (forcedAttack) {
    notice.classList.remove('hidden');
    notice.textContent = `Forced trade — hand ${hand.length}. Trade a set to continue attacking.`;
  } else {
    notice.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CARD MODAL
// ══════════════════════════════════════════════════════════════════════════

function openCardModal(gameState) {
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  _selectedCards = [];
  _renderCardModal(gameState);
  modal.classList.remove('hidden');
}

function closeCardModal() {
  // Don't close if a forced trade is required and the player hasn't traded.
  if (typeof GAME_STATE !== 'undefined' &&
      GAME_STATE.phase === 'attack' && GAME_STATE.attackTradeRequired) {
    return;
  }
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  _selectedCards = [];
}

function _renderCardModal(gameState) {
  const grid   = document.getElementById('card-grid');
  const status = document.getElementById('trade-preview-status');
  const detail = document.getElementById('trade-preview-detail');
  const btn    = document.getElementById('btn-trade-in');
  const preview = document.getElementById('trade-preview');
  const hintEl = document.getElementById('card-modal-hint');
  const cancelBtn = document.getElementById('btn-card-cancel');
  const closeBtn = document.querySelector('#card-modal .modal-close');
  if (!grid || !status || !detail || !btn) return;

  const player = _viewedPlayer(gameState);
  const hand   = gameState.hands[player.id] || [];

  const title = document.getElementById('card-modal-title');
  if (title) title.textContent = `${player.name} — Your Cards`;

  // Update hint + cancel/close availability based on forced-trade status.
  // Like renderCardsSummary, this only applies when the hand we're
  // showing is also the current player's — i.e. it's actually my turn.
  const isMyTurn = player.id === PLAYERS[gameState.currentPlayerIndex].id;
  const forcedNow = isMyTurn && (
    (gameState.phase === 'reinforce' && mustTradeIn(gameState)) ||
    (gameState.phase === 'attack'    && gameState.attackTradeRequired));
  if (hintEl) {
    if (forcedNow) {
      hintEl.className = 'modal-hint forced-hint';
      hintEl.textContent = `You must trade in a set (hand ${hand.length}) before continuing.`;
    } else {
      hintEl.className = 'modal-hint';
      hintEl.textContent = 'Select 3 cards to trade in for armies. Valid sets: 3 of the same type, 1 of each type, or any set containing a wildcard.';
    }
  }
  if (cancelBtn) cancelBtn.style.display = forcedNow ? 'none' : '';
  if (closeBtn)  closeBtn.style.display  = forcedNow ? 'none' : '';

  grid.innerHTML = '';
  for (const cardId of hand) {
    const card = CARDS[cardId];
    if (!card) continue;
    const tile = document.createElement('div');
    tile.className = 'card-tile';
    tile.setAttribute('data-card-id', cardId);
    if (_selectedCards.includes(cardId)) tile.classList.add('selected');

    const img = document.createElement('img');
    img.src = card.image;
    img.alt = card.territory ? TERRITORIES[card.territory]?.name || card.territory : 'Wildcard';
    img.loading = 'lazy';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'card-type-badge';
    typeBadge.textContent = card.type;

    tile.appendChild(img);
    tile.appendChild(typeBadge);

    if (card.territory && gameState.territories[card.territory]?.owner === player.id) {
      const ownedBadge = document.createElement('span');
      ownedBadge.className = 'card-owned-badge';
      ownedBadge.textContent = 'OWNED';
      tile.appendChild(ownedBadge);
    }

    tile.addEventListener('click', () => {
      const idx = _selectedCards.indexOf(cardId);
      if (idx >= 0) _selectedCards.splice(idx, 1);
      else if (_selectedCards.length < 3) _selectedCards.push(cardId);
      else { _selectedCards.shift(); _selectedCards.push(cardId); }
      _renderCardModal(gameState);
    });

    grid.appendChild(tile);
  }

  if (_selectedCards.length < 3) {
    preview.classList.remove('valid', 'invalid');
    status.textContent = `Select ${3 - _selectedCards.length} more card${_selectedCards.length === 2 ? '' : 's'}`;
    detail.textContent = '';
    btn.disabled = true;
    return;
  }

  if (isValidTradeSet(_selectedCards)) {
    const nextValue = tradeSetValue(gameState.tradeInCount + 1);
    const label = tradeSetLabel(_selectedCards);
    const ownedInSet = ownedTerritoriesInSet(_selectedCards, gameState.territories, player.id);
    const bonusText = ownedInSet.length > 0
      ? ` (+2 on each of ${ownedInSet.map(t => TERRITORIES[t]?.name || t).join(', ')})`
      : '';
    preview.classList.remove('invalid');
    preview.classList.add('valid');
    status.textContent = `Valid: ${label} → +${nextValue} armies${bonusText}`;
    detail.textContent = `Set #${gameState.tradeInCount + 1} traded overall.`;
    btn.disabled = false;
  } else {
    preview.classList.remove('valid');
    preview.classList.add('invalid');
    status.textContent = 'Not a valid set';
    detail.textContent = 'Valid sets: 3 of same type, 1 of each, or any set containing a wildcard.';
    btn.disabled = true;
  }
}

async function _submitTrade() {
  if (_selectedCards.length !== 3) return;
  if (!canTradeIn(GAME_STATE, _selectedCards)) return;
  const cardIds = _selectedCards.slice();
  _selectedCards = [];

  const res = await _sendAction('tradeIn', { cardIds });
  if (!res.ok) { alert(res.error || 'Could not trade in that set.'); return; }

  // sendAction already triggered a full re-render; GAME_STATE here is the
  // fresh post-trade state. If a forced trade is still required (hand
  // still ≥ 5), keep the modal open and refresh just its contents — the
  // general render loop doesn't touch this modal's internals.
  if (GAME_STATE.phase === 'attack' && GAME_STATE.attackTradeRequired) {
    _renderCardModal(GAME_STATE);
    return;
  }

  const modal = document.getElementById('card-modal');
  if (modal) modal.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════════════════
// COMBAT MODAL
// ══════════════════════════════════════════════════════════════════════════

function openCombatModal(gameState, attackerId, defenderId) {
  _combatCtx = {
    attackerId, defenderId,
    chosenDice: getMaxAttackerDice(gameState, attackerId),
    lastResult: null,
    blitzActive: false
  };
  _renderCombatModal(gameState);
  document.getElementById('combat-modal').classList.remove('hidden');
}
function _closeCombatModal() {
  document.getElementById('combat-modal').classList.add('hidden');
  _combatCtx = null;
}

function _renderCombatModal(gameState) {
  if (!_combatCtx) return;
  const { attackerId, defenderId, chosenDice, lastResult, blitzActive } = _combatCtx;
  const a = gameState.territories[attackerId];
  const d = gameState.territories[defenderId];
  if (!a || !d) return;

  const attackerPlayer = PLAYERS.find(p => p.id === a.owner);
  const defenderPlayer = PLAYERS.find(p => p.id === d.owner);

  document.getElementById('combat-modal-title').textContent =
    `${TERRITORIES[attackerId].name} → ${TERRITORIES[defenderId].name}`;

  const aName = document.getElementById('combat-attacker-name');
  const dName = document.getElementById('combat-defender-name');
  aName.textContent = `${TERRITORIES[attackerId].name} · ${attackerPlayer.name}`;
  aName.style.color = attackerPlayer.color;
  dName.textContent = `${TERRITORIES[defenderId].name} · ${defenderPlayer.name}`;
  dName.style.color = defenderPlayer.color;

  document.getElementById('combat-attacker-armies').textContent = `${a.armies} armies`;
  document.getElementById('combat-defender-armies').textContent = `${d.armies} armies`;

  const maxA = getMaxAttackerDice(gameState, attackerId);
  document.querySelectorAll('#combat-attacker-dice-picker .dice-picker-btn').forEach(btn => {
    const val = parseInt(btn.getAttribute('data-dice'), 10);
    btn.disabled = val > maxA || blitzActive;
    btn.classList.toggle('selected', val === chosenDice);
  });

  const aDiceRow = document.getElementById('combat-attacker-dice');
  const dDiceRow = document.getElementById('combat-defender-dice');
  aDiceRow.innerHTML = '';
  dDiceRow.innerHTML = '';
  if (lastResult) {
    lastResult.attackerRolls.forEach((v, i) => aDiceRow.appendChild(_die(v, _dieClass(v, lastResult.defenderRolls[i]))));
    lastResult.defenderRolls.forEach((v, i) => {
      const attackerVal = lastResult.attackerRolls[i];
      let cls = '';
      if (attackerVal !== undefined) cls = attackerVal > v ? 'lose' : 'win';
      dDiceRow.appendChild(_die(v, cls));
    });
  }

  const resultEl = document.getElementById('combat-result');
  resultEl.classList.toggle('blitzing', blitzActive);
  if (blitzActive) {
    resultEl.textContent = 'Blitzing…';
  } else if (lastResult) {
    let text = `Attacker −${lastResult.attackerLosses}, defender −${lastResult.defenderLosses}.`;
    if (lastResult.conquered) text += ' Territory conquered!';
    else if (lastResult.mustRetreat) text += ' Attacker forced to retreat (only 1 army left).';
    resultEl.textContent = text;
  } else {
    resultEl.textContent = 'Choose dice count, then Roll or Blitz.';
  }

  const canAtk = canAttack(gameState, attackerId, defenderId);
  document.getElementById('btn-combat-roll').disabled  = !canAtk || blitzActive;
  document.getElementById('btn-combat-blitz').disabled = !canAtk || blitzActive;
  document.getElementById('btn-combat-retreat').disabled = blitzActive;
  document.getElementById('btn-combat-close').disabled   = blitzActive;
}

function _die(value, cls) {
  const el = document.createElement('div');
  el.className = 'die' + (cls ? ' ' + cls : '');
  el.textContent = value;
  return el;
}
function _dieClass(a, d) {
  if (d === undefined) return '';
  return a > d ? 'win' : 'lose';
}

// Dice are now rolled server-side (see gameEngine.js's 'attack' action) so
// the result is authoritative and identical for every player watching —
// that means every roll here is a network round trip (or, in local/dev
// play, an instantly-resolved local one via _sendAction's fallback).
async function _combatRollOnce() {
  if (!_combatCtx) return;
  const { attackerId, defenderId, chosenDice } = _combatCtx;
  const res = await _sendAction('attack', { attackerId, defenderId, dice: chosenDice });
  if (!_combatCtx) return; // modal was closed while this was in flight
  if (!res.ok) { alert(res.error || 'Attack failed.'); return; }

  const result = res.result;
  _combatCtx.lastResult = result;
  if (result.conquered) {
    _closeCombatModal();
    openMoveModal(GAME_STATE);
    return;
  }
  const maxA = getMaxAttackerDice(GAME_STATE, attackerId);
  if (_combatCtx.chosenDice > maxA) _combatCtx.chosenDice = maxA;
  _renderCombatModal(GAME_STATE);
}

// Animated blitz: staggered rolls with a visible delay between each. Each
// step awaits its own server round trip before the next one is scheduled.
async function _combatBlitz() {
  if (!_combatCtx) return;
  _combatCtx.blitzActive = true;
  _renderCombatModal(GAME_STATE);

  let steps = 0;
  const MAX_STEPS = 200;

  const runNext = async () => {
    if (!_combatCtx) return;
    if (++steps > MAX_STEPS) { _combatCtx.blitzActive = false; _renderCombatModal(GAME_STATE); return; }

    const { attackerId, defenderId } = _combatCtx;
    if (!canAttack(GAME_STATE, attackerId, defenderId)) {
      _combatCtx.blitzActive = false;
      _renderCombatModal(GAME_STATE);
      return;
    }
    const maxA = getMaxAttackerDice(GAME_STATE, attackerId);
    const dice = Math.min(_combatCtx.chosenDice, maxA);

    const res = await _sendAction('attack', { attackerId, defenderId, dice });
    if (!_combatCtx) return; // modal was closed while this was in flight
    if (!res.ok) {
      _combatCtx.blitzActive = false;
      _renderCombatModal(GAME_STATE);
      return;
    }
    const result = res.result;
    _combatCtx.lastResult = result;
    _renderCombatModal(GAME_STATE);

    if (result.conquered) {
      setTimeout(() => {
        if (!_combatCtx) return;
        _combatCtx.blitzActive = false;
        _closeCombatModal();
        openMoveModal(GAME_STATE);
      }, BLITZ_ROLL_DELAY_MS);
      return;
    }
    if (result.mustRetreat) {
      setTimeout(() => {
        if (_combatCtx) { _combatCtx.blitzActive = false; _renderCombatModal(GAME_STATE); }
      }, BLITZ_ROLL_DELAY_MS);
      return;
    }
    setTimeout(runNext, BLITZ_ROLL_DELAY_MS);
  };

  setTimeout(runNext, BLITZ_ROLL_DELAY_MS);
}

function _combatRetreat() {
  if (!_combatCtx) return;
  if (_combatCtx.blitzActive) return; // ignore during blitz
  _closeCombatModal();
  _dispatch();
}

// ══════════════════════════════════════════════════════════════════════════
// MOVE-ARMIES MODAL (after conquest)
// ══════════════════════════════════════════════════════════════════════════

function openMoveModal(gameState) {
  const pc = gameState.pendingConquest;
  if (!pc) return;
  const modal = document.getElementById('move-modal');
  if (!modal) return;
  _renderMoveModal(gameState);
  modal.classList.remove('hidden');
}

function _renderMoveModal(gameState) {
  const pc = gameState.pendingConquest;
  if (!pc) return;
  const a = gameState.territories[pc.attackerId];
  const min = pc.minMove;
  const max = Math.max(min, Math.min(pc.maxMove, a.armies - 1));

  document.getElementById('move-from-name').textContent = TERRITORIES[pc.attackerId].name;
  document.getElementById('move-to-name').textContent   = TERRITORIES[pc.defenderId].name;

  const slider = document.getElementById('move-slider');
  slider.min = String(min);
  slider.max = String(max);
  if (parseInt(slider.value, 10) < min) slider.value = String(min);
  if (parseInt(slider.value, 10) > max) slider.value = String(max);

  document.getElementById('move-slider-value').textContent = slider.value;
  document.getElementById('move-range-note').textContent =
    `Must move at least ${min} (dice rolled). Max ${max} (leave ≥ 1 behind).`;

  const val = parseInt(slider.value, 10);
  document.getElementById('move-from-armies').textContent = String(a.armies - val);
  document.getElementById('move-to-armies').textContent   = String(val);
}

async function _confirmMove() {
  const pc = GAME_STATE.pendingConquest;
  if (!pc) return;
  const n = parseInt(document.getElementById('move-slider').value, 10);

  const res = await _sendAction('applyConquest', { armies: n });
  document.getElementById('move-modal').classList.add('hidden');
  if (!res.ok) { alert(res.error || 'Could not move armies.'); return; }

  // sendAction already re-rendered; GAME_STATE here is the fresh post-move
  // state. Open whatever modal that state now calls for.
  if (GAME_STATE.phase === 'gameover' && GAME_STATE.winner) {
    openGameOverModal(GAME_STATE);
    return;
  }
  if (GAME_STATE.phase === 'attack' && GAME_STATE.attackTradeRequired) {
    openCardModal(GAME_STATE);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FORTIFY MODAL
// ══════════════════════════════════════════════════════════════════════════

function openFortifyModal(gameState, sourceId, destId) {
  const modal = document.getElementById('fortify-modal');
  if (!modal) return;
  modal.setAttribute('data-source', sourceId);
  modal.setAttribute('data-dest',   destId);
  _renderFortifyModal(gameState);
  modal.classList.remove('hidden');
}
function _closeFortifyModal() {
  document.getElementById('fortify-modal').classList.add('hidden');
}

function _getFortifyPair() {
  const modal = document.getElementById('fortify-modal');
  return { sourceId: modal.getAttribute('data-source'), destId: modal.getAttribute('data-dest') };
}

function _renderFortifyModal(gameState) {
  const { sourceId, destId } = _getFortifyPair();
  const src = gameState.territories[sourceId];
  const dst = gameState.territories[destId];
  if (!src || !dst) return;

  document.getElementById('fortify-from-name').textContent = TERRITORIES[sourceId].name;
  document.getElementById('fortify-to-name').textContent   = TERRITORIES[destId].name;

  const max = src.armies - 1;
  const min = 1;
  const slider = document.getElementById('fortify-slider');
  slider.min = String(min);
  slider.max = String(max);
  if (parseInt(slider.value, 10) < min) slider.value = String(min);
  if (parseInt(slider.value, 10) > max) slider.value = String(max);

  document.getElementById('fortify-slider-value').textContent = slider.value;
  document.getElementById('fortify-range-note').textContent =
    `Min 1, max ${max} (must leave ≥ 1 army behind).`;

  const val = parseInt(slider.value, 10);
  document.getElementById('fortify-from-armies').textContent = String(src.armies - val);
  document.getElementById('fortify-to-armies').textContent   = String(dst.armies + val);
}

async function _confirmFortify() {
  const { sourceId, destId } = _getFortifyPair();
  const n = parseInt(document.getElementById('fortify-slider').value, 10);

  // The 'fortify' action moves the armies AND ends the turn as one atomic
  // step (matching how this always worked: a fortify always ends the
  // turn), so there's no separate "advance turn" call needed here anymore.
  const res = await _sendAction('fortify', { sourceId, destId, armies: n });
  if (!res.ok) { alert(res.error || 'Could not fortify.'); return; }
  _closeFortifyModal();
}

// ══════════════════════════════════════════════════════════════════════════
// GAME OVER MODAL
// ══════════════════════════════════════════════════════════════════════════

function openGameOverModal(gameState) {
  const modal = document.getElementById('gameover-modal');
  const winnerEl = document.getElementById('gameover-winner');
  if (!modal || !winnerEl) return;
  const winner = PLAYERS.find(p => p.id === gameState.winner);
  winnerEl.textContent = winner ? winner.name : 'Unknown';
  if (winner) winnerEl.style.color = winner.color;
  modal.classList.remove('hidden');
}

// ══════════════════════════════════════════════════════════════════════════
// HEADER BUTTONS
// ══════════════════════════════════════════════════════════════════════════

function renderHeaderButtons(gameState) {
  const btn = document.getElementById('btn-end-phase');
  const skipBtn = document.getElementById('btn-skip-fortify');
  if (!btn) return;

  if (gameState.phase === 'setup') {
    btn.disabled = true;
    const player = PLAYERS[gameState.currentPlayerIndex];
    btn.textContent = `${player.name}: ${setupArmiesLeft(gameState, player.id)} to place`;
    if (skipBtn) skipBtn.classList.add('hidden');
  } else if (gameState.phase === 'reinforce') {
    const ready = gameState.armiesRemaining === 0 && !mustTradeIn(gameState);
    btn.disabled = !ready;
    btn.textContent = ready ? 'End Reinforce →' : `Place ${gameState.armiesRemaining} more`;
    if (skipBtn) skipBtn.classList.add('hidden');
  } else if (gameState.phase === 'attack') {
    const blocked = !!gameState.pendingConquest || gameState.attackTradeRequired || gameState.forcedPlacement;
    btn.disabled = blocked;
    if (gameState.attackTradeRequired) btn.textContent = 'Trade required';
    else if (gameState.forcedPlacement) btn.textContent = `Place ${gameState.armiesRemaining} armies`;
    else btn.textContent = 'End Attack →';
    if (skipBtn) skipBtn.classList.add('hidden');
  } else if (gameState.phase === 'fortify') {
    btn.disabled = true;
    btn.textContent = 'Fortify in progress…';
    if (skipBtn) skipBtn.classList.remove('hidden');
  } else {
    btn.disabled = true;
    btn.textContent = 'End Phase';
    if (skipBtn) skipBtn.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ONE-TIME MODAL WIRING (called by main.js)
// ══════════════════════════════════════════════════════════════════════════

function wireModalEvents() {
  // Card modal
  const cardModal = document.getElementById('card-modal');
  if (cardModal) cardModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeCardModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCardModal();
      if (_combatCtx && !_combatCtx.blitzActive) _combatRetreat();
      _closeFortifyModal();
    }
  });
  document.getElementById('btn-trade-in')?.addEventListener('click', () => {
    if (typeof GAME_STATE !== 'undefined') _submitTrade();
  });

  // Combat modal
  document.querySelectorAll('#combat-attacker-dice-picker .dice-picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_combatCtx || _combatCtx.blitzActive) return;
      _combatCtx.chosenDice = parseInt(btn.getAttribute('data-dice'), 10);
      _renderCombatModal(GAME_STATE);
    });
  });
  document.getElementById('btn-combat-roll')?.addEventListener('click', () => {
    if (typeof GAME_STATE !== 'undefined') _combatRollOnce();
  });
  document.getElementById('btn-combat-blitz')?.addEventListener('click', () => {
    if (typeof GAME_STATE !== 'undefined') _combatBlitz();
  });
  document.getElementById('btn-combat-retreat')?.addEventListener('click', _combatRetreat);
  document.getElementById('btn-combat-close')?.addEventListener('click', _combatRetreat);

  // Move-armies modal
  document.getElementById('move-slider')?.addEventListener('input', () => {
    if (typeof GAME_STATE !== 'undefined') _renderMoveModal(GAME_STATE);
  });
  document.getElementById('btn-move-confirm')?.addEventListener('click', () => {
    if (typeof GAME_STATE !== 'undefined') _confirmMove();
  });

  // Fortify modal
  document.getElementById('fortify-slider')?.addEventListener('input', () => {
    if (typeof GAME_STATE !== 'undefined') _renderFortifyModal(GAME_STATE);
  });
  document.getElementById('btn-fortify-confirm')?.addEventListener('click', () => {
    if (typeof GAME_STATE !== 'undefined') _confirmFortify();
  });
  document.getElementById('btn-fortify-cancel')?.addEventListener('click', _closeFortifyModal);
  document.getElementById('btn-fortify-close')?.addEventListener('click', _closeFortifyModal);
  document.getElementById('fortify-backdrop')?.addEventListener('click', _closeFortifyModal);
}
