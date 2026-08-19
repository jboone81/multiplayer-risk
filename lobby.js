// lobby.js — Client-side lobby: connects to the server via Socket.IO,
// wires the entry form, in-room player list, chat, and Start button.

'use strict';

(function () {

  // ── DOM refs ────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const viewEntry     = $('view-entry');
  const viewRoom      = $('view-room');
  const connIndicator = $('conn-indicator');
  const connLabel     = connIndicator.querySelector('.conn-label');

  const entryName    = $('entry-name');
  const entryCode    = $('entry-code');
  const btnCreate    = $('btn-create');
  const btnJoin      = $('btn-join');
  const entryError   = $('entry-error');

  const roomCodeEl   = $('room-code');
  const btnCopyCode  = $('btn-copy-code');
  const btnLeave     = $('btn-leave');
  const playerListEl = $('player-list');
  const playerCount  = $('player-count');
  const btnReady     = $('btn-ready');
  const btnStart     = $('btn-start');
  const startHint    = $('start-hint');

  const continentSettingsEl = $('continent-settings');
  const settingsHintEl      = $('settings-hint');
  const CONTINENT_BONUS_MIN = 1;
  const CONTINENT_BONUS_MAX = 15;

  // ── Client-side state ──────────────────────────────────────────────
  let myPlayerId = null;
  let roomState  = null;   // last received roomState payload

  // Cache the name so on reload / errors the user doesn't have to retype.
  const NAME_KEY = 'risk_lobby_name_v1';
  const savedName = safeStorageGet(NAME_KEY);
  if (savedName) entryName.value = savedName;

  // Auto-fill room code from ?room=XYZ query string, if present.
  const urlParams = new URLSearchParams(location.search);
  const preRoom = (urlParams.get('room') || '').toUpperCase();
  if (preRoom) entryCode.value = preRoom;

  refreshEntryButtons();

  // ── Socket.IO connection ───────────────────────────────────────────
  const socket = io();

  socket.on('connect', () => {
    setConn(true, 'Connected');
    myPlayerId = socket.id;
  });
  socket.on('disconnect', () => {
    setConn(false, 'Disconnected');
    // Server-side we'll be removed from any room. Clear local state.
    roomState = null;
    myPlayerId = null;
    if (!viewEntry.classList.contains('hidden')) return; // already on entry
    setEntryError('Lost connection to server. You have been removed from the room.');
    showView('entry');
  });
  socket.on('connect_error', () => setConn(false, 'Cannot reach server'));

  // Server → client: full room snapshot
  socket.on('roomState', (state) => {
    roomState = state;
    renderRoom();
  });

  // Server → client: game is starting
  socket.on('gameStarting', ({ code }) => {
    // Pass our stable playerId along too — this lobby socket is about to
    // die (full page navigation), and index.html's fresh socket needs this
    // id to prove "I'm the same player" via the joinGame handshake.
    const params = new URLSearchParams({ room: code, pid: myPlayerId || '' });
    window.location.href = `index.html?${params.toString()}`;
  });

  // ── Entry form ─────────────────────────────────────────────────────
  entryName.addEventListener('input', refreshEntryButtons);
  entryCode.addEventListener('input', () => {
    entryCode.value = entryCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    refreshEntryButtons();
  });

  btnCreate.addEventListener('click', () => {
    const name = entryName.value.trim();
    if (!name) return;
    safeStorageSet(NAME_KEY, name);
    setEntryError('');
    btnCreate.disabled = true;
    socket.emit('createRoom', { name }, (res) => {
      btnCreate.disabled = false;
      if (!res || !res.ok) { setEntryError(res && res.error || 'Failed to create room.'); return; }
      myPlayerId = res.playerId;
      showView('room');
    });
  });

  btnJoin.addEventListener('click', () => {
    const name = entryName.value.trim();
    const code = entryCode.value.trim().toUpperCase();
    if (!name || !code) return;
    safeStorageSet(NAME_KEY, name);
    setEntryError('');
    btnJoin.disabled = true;
    socket.emit('joinRoom', { name, code }, (res) => {
      btnJoin.disabled = false;
      if (!res || !res.ok) { setEntryError(res && res.error || 'Failed to join.'); return; }
      myPlayerId = res.playerId;
      showView('room');
    });
  });

  // Enter key on name → depends on whether a code is filled in
  entryName.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (entryCode.value.length === 5) btnJoin.click();
    else btnCreate.click();
  });
  entryCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // ── In-room actions ────────────────────────────────────────────────
  btnCopyCode.addEventListener('click', () => {
    if (!roomState) return;
    navigator.clipboard?.writeText(roomState.code).then(() => {
      const orig = btnCopyCode.textContent;
      btnCopyCode.textContent = 'Copied!';
      setTimeout(() => { btnCopyCode.textContent = orig; }, 1200);
    }).catch(() => {});
  });

  btnLeave.addEventListener('click', () => {
    socket.emit('leaveRoom', {}, () => {
      roomState = null;
      showView('entry');
      setEntryError('');
    });
  });

  btnReady.addEventListener('click', () => {
    socket.emit('toggleReady', {}, () => {});
  });

  btnStart.addEventListener('click', () => {
    btnStart.disabled = true;
    socket.emit('startGame', {}, (res) => {
      btnStart.disabled = false;
      if (!res || !res.ok) {
        alert(res && res.error || 'Could not start game.');
      }
    });
  });

  // ── Render ─────────────────────────────────────────────────────────
  function refreshEntryButtons() {
    const nameOk = entryName.value.trim().length > 0;
    btnCreate.disabled = !nameOk;
    btnJoin.disabled   = !(nameOk && entryCode.value.trim().length === 5);
  }

  function setEntryError(msg) {
    entryError.textContent = msg || '';
  }

  function setConn(ok, label) {
    connIndicator.classList.toggle('is-connected', !!ok);
    connLabel.textContent = label;
  }

  function showView(name) {
    viewEntry.classList.toggle('hidden', name !== 'entry');
    viewRoom.classList.toggle('hidden', name !== 'room');
  }

  function renderRoom() {
    if (!roomState) return;
    roomCodeEl.textContent = roomState.code;
    playerCount.textContent = `(${roomState.players.length}/6)`;

    // Player list
    playerListEl.innerHTML = '';
    for (const p of roomState.players) {
      const isMe   = p.id === myPlayerId;
      const isHost = p.id === roomState.hostId;
      const card = document.createElement('div');
      card.className = `player-row ${isMe ? 'is-me' : ''}`;
      card.innerHTML = `
        <div class="player-dot" style="background:${p.color.hex}; box-shadow:0 0 8px ${p.color.hex}99;"></div>
        <div class="player-name">
          ${escapeHtml(p.name)}
          ${isHost ? '<span class="badge badge-host">HOST</span>' : ''}
          ${isMe   ? '<span class="badge badge-you">YOU</span>'  : ''}
        </div>
        <div class="player-ready ${p.ready ? 'yes' : 'no'}">${p.ready ? 'Ready' : 'Not ready'}</div>
      `;

      // Clicking your own player-dot cycles your color to the next available.
      if (isMe) {
        const dot = card.querySelector('.player-dot');
        dot.style.cursor = 'pointer';
        dot.title = 'Click to change color';
        dot.addEventListener('click', () => cycleMyColor(p.color.hex));
      }

      playerListEl.appendChild(card);
    }

    // Ready button reflects my own ready state
    const me = roomState.players.find(p => p.id === myPlayerId);
    if (me) {
      btnReady.textContent = me.ready ? 'Not Ready' : 'Ready ✓';
      btnReady.classList.toggle('btn-primary', !me.ready);
      btnReady.classList.toggle('btn-secondary', me.ready);
    }

    // Start button (host only)
    const iAmHost = roomState.hostId === myPlayerId;
    btnStart.classList.toggle('hidden', !iAmHost);
    if (iAmHost) {
      const allReady    = roomState.players.every(p => p.ready);
      const enoughPlayers = roomState.players.length >= 2;
      btnStart.disabled = !(allReady && enoughPlayers);
      if (!enoughPlayers) startHint.textContent = 'Need at least 2 players.';
      else if (!allReady) startHint.textContent = 'Waiting for all players to be ready.';
      else                startHint.textContent = 'All set — hit Start Game.';
    } else {
      startHint.textContent = 'Waiting for host to start the game.';
    }

    renderContinentSettings();
  }

  // Continent bonus-army settings — host can tune each continent's bonus
  // with up/down steppers before starting; everyone else sees the current
  // values read-only. Values live on the server (room.continentBonuses) and
  // get applied to the real game engine at startGame time.
  function renderContinentSettings() {
    if (!roomState || !Array.isArray(roomState.continents)) return;
    const iAmHost = roomState.hostId === myPlayerId;
    settingsHintEl.textContent = iAmHost ? '' : '(host only)';

    continentSettingsEl.innerHTML = '';
    for (const cont of roomState.continents) {
      const row = document.createElement('div');
      row.className = 'continent-row';
      row.innerHTML = `
        <span class="continent-name">${escapeHtml(cont.name)}</span>
        <div class="continent-stepper">
          <button type="button" class="stepper-btn" data-dir="-1" data-id="${cont.id}" ${iAmHost ? '' : 'disabled'}>−</button>
          <span class="continent-value">${cont.bonus}</span>
          <button type="button" class="stepper-btn" data-dir="1" data-id="${cont.id}" ${iAmHost ? '' : 'disabled'}>+</button>
        </div>
      `;
      continentSettingsEl.appendChild(row);
    }
  }

  // Event delegation: stepper buttons are rebuilt on every render, so wire
  // the click handler once on the container instead of per-button.
  continentSettingsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn || btn.disabled || !roomState) return;
    const continentId = btn.dataset.id;
    const dir = Number(btn.dataset.dir);
    const cont = roomState.continents.find(c => c.id === continentId);
    if (!cont) return;
    const nextBonus = Math.max(CONTINENT_BONUS_MIN, Math.min(CONTINENT_BONUS_MAX, cont.bonus + dir));
    if (nextBonus === cont.bonus) return;
    btn.disabled = true;
    socket.emit('setContinentBonus', { continentId, bonus: nextBonus }, (res) => {
      // On success the server's roomState broadcast re-renders this panel
      // (with a fresh, enabled button) anyway. On failure no broadcast is
      // coming, so re-render here ourselves to un-stick the button.
      if (!res || !res.ok) renderContinentSettings();
    });
  });

  function cycleMyColor(currentHex) {
    // Fetch preset colors from the current state (all players + implicit)
    // by trying each known preset until the server accepts one.
    const presets = ['#e05252', '#4a8fd4', '#4caf6e', '#f0d040', '#ec6ba0', '#2a2a2a'];
    const idx = presets.indexOf(currentHex);
    const order = [];
    for (let i = 1; i <= presets.length; i++) {
      order.push(presets[(idx + i) % presets.length]);
    }
    // Try each in turn until the server accepts one.
    const tryNext = (i) => {
      if (i >= order.length) return;
      socket.emit('changeColor', { hex: order[i] }, (res) => {
        if (res && res.ok) return;
        tryNext(i + 1);
      });
    };
    tryNext(0);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function safeStorageGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function safeStorageSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

})();
