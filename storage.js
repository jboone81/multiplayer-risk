// storage.js — Save/load game state to browser localStorage.

'use strict';

const STORAGE_VERSION = 'v4';   // bumped for forced-trade + forced-placement state
const STORAGE_KEY     = 'risk-game-state-' + STORAGE_VERSION;

function saveState(state) {
  try {
    const payload = { version: STORAGE_VERSION, savedAt: Date.now(), state };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('[RISK] Save failed:', err);
    return false;
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || payload.version !== STORAGE_VERSION || !payload.state) return null;
    return payload.state;
  } catch (err) {
    console.warn('[RISK] Load failed:', err);
    return null;
  }
}

function clearState() {
  try { localStorage.removeItem(STORAGE_KEY); return true; }
  catch (err) { console.warn('[RISK] Clear failed:', err); return false; }
}

function isStorageAvailable() {
  try {
    const testKey = '__risk_storage_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch (_) { return false; }
}
