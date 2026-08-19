// cards.js — Deck definition (44 cards), shuffling, dealing, trade-in logic.

'use strict';

const UNIT_INFANTRY  = 'infantry';
const UNIT_CAVALRY   = 'cavalry';
const UNIT_ARTILLERY = 'artillery';
const UNIT_WILD      = 'wild';

const CARDS = {
  // Infantry (14)
  'card-centralAmerica': { id: 'card-centralAmerica', territory: 'centralAmerica', type: UNIT_INFANTRY,  image: 'assets/NAcentral.jpg'  },
  'card-brazil':         { id: 'card-brazil',         territory: 'brazil',         type: UNIT_INFANTRY,  image: 'assets/SAbrazil.jpg'   },
  'card-argentina':      { id: 'card-argentina',      territory: 'argentina',      type: UNIT_INFANTRY,  image: 'assets/SAargentina.jpg'},
  'card-scandinavia':    { id: 'card-scandinavia',    territory: 'scandinavia',    type: UNIT_INFANTRY,  image: 'assets/EUscan.jpg'     },
  'card-ukraine':        { id: 'card-ukraine',        territory: 'ukraine',        type: UNIT_INFANTRY,  image: 'assets/EUukraine.jpg'  },
  'card-greatBritain':   { id: 'card-greatBritain',   territory: 'greatBritain',   type: UNIT_INFANTRY,  image: 'assets/EUbritain.jpg'  },
  'card-westernEurope':  { id: 'card-westernEurope',  territory: 'westernEurope',  type: UNIT_INFANTRY,  image: 'assets/EUwest.jpg'     },
  'card-southernEurope': { id: 'card-southernEurope', territory: 'southernEurope', type: UNIT_INFANTRY,  image: 'assets/EUsouth.jpg'    },
  'card-northAfrica':    { id: 'card-northAfrica',    territory: 'northAfrica',    type: UNIT_INFANTRY,  image: 'assets/AFnorth.jpg'    },
  'card-eastAfrica':     { id: 'card-eastAfrica',     territory: 'eastAfrica',     type: UNIT_INFANTRY,  image: 'assets/AFeast.jpg'     },
  'card-ural':           { id: 'card-ural',           territory: 'ural',           type: UNIT_INFANTRY,  image: 'assets/ASural.jpg'     },
  'card-siberia':        { id: 'card-siberia',        territory: 'siberia',        type: UNIT_INFANTRY,  image: 'assets/ASsiberia.jpg'  },
  'card-afghanistan':    { id: 'card-afghanistan',    territory: 'afghanistan',    type: UNIT_INFANTRY,  image: 'assets/ASafghanistan.jpg' },
  'card-indonesia':      { id: 'card-indonesia',      territory: 'indonesia',      type: UNIT_INFANTRY,  image: 'assets/AUindo.jpg'     },

  // Cavalry (14)
  'card-northwest':        { id: 'card-northwest',        territory: 'northwest',        type: UNIT_CAVALRY, image: 'assets/NAnorthwest.jpg' },
  'card-greenland':        { id: 'card-greenland',        territory: 'greenland',        type: UNIT_CAVALRY, image: 'assets/NAgreenland.jpg' },
  'card-venezuela':        { id: 'card-venezuela',        territory: 'venezuela',        type: UNIT_CAVALRY, image: 'assets/SAvenezuela.jpg' },
  'card-peru':             { id: 'card-peru',             territory: 'peru',             type: UNIT_CAVALRY, image: 'assets/SAperu.jpg'      },
  'card-iceland':          { id: 'card-iceland',          territory: 'iceland',          type: UNIT_CAVALRY, image: 'assets/EUiceland.jpg'   },
  'card-northernEurope':   { id: 'card-northernEurope',   territory: 'northernEurope',   type: UNIT_CAVALRY, image: 'assets/EUnorth.jpg'     },
  'card-egypt':            { id: 'card-egypt',            territory: 'egypt',            type: UNIT_CAVALRY, image: 'assets/AFegypt.jpg'     },
  'card-madagascar':       { id: 'card-madagascar',       territory: 'madagascar',       type: UNIT_CAVALRY, image: 'assets/AFmadagascar.jpg'},
  'card-mongolia':         { id: 'card-mongolia',         territory: 'mongolia',         type: UNIT_CAVALRY, image: 'assets/ASmongolia.jpg'  },
  'card-japan':            { id: 'card-japan',            territory: 'japan',            type: UNIT_CAVALRY, image: 'assets/ASjapan.jpg'     },
  'card-india':            { id: 'card-india',            territory: 'india',            type: UNIT_CAVALRY, image: 'assets/ASindia.jpg'     },
  'card-siam':             { id: 'card-siam',             territory: 'siam',             type: UNIT_CAVALRY, image: 'assets/ASsiam.jpg'      },
  'card-newGuinea':        { id: 'card-newGuinea',        territory: 'newGuinea',        type: UNIT_CAVALRY, image: 'assets/AUnew.jpg'       },
  'card-easternAustralia': { id: 'card-easternAustralia', territory: 'easternAustralia', type: UNIT_CAVALRY, image: 'assets/AUeastern.jpg'   },

  // Artillery (14)
  'card-alaska':           { id: 'card-alaska',           territory: 'alaska',           type: UNIT_ARTILLERY, image: 'assets/NAalaska.jpg'    },
  'card-alberta':          { id: 'card-alberta',          territory: 'alberta',          type: UNIT_ARTILLERY, image: 'assets/NAalberta.jpg'   },
  'card-ontario':          { id: 'card-ontario',          territory: 'ontario',          type: UNIT_ARTILLERY, image: 'assets/NAontario.jpg'   },
  'card-quebec':           { id: 'card-quebec',           territory: 'quebec',           type: UNIT_ARTILLERY, image: 'assets/NAquebec.jpg'    },
  'card-westernUs':        { id: 'card-westernUs',        territory: 'westernUs',        type: UNIT_ARTILLERY, image: 'assets/NAwestern.jpg'   },
  'card-easternUs':        { id: 'card-easternUs',        territory: 'easternUs',        type: UNIT_ARTILLERY, image: 'assets/NAeastern.jpg'   },
  'card-congo':            { id: 'card-congo',            territory: 'congo',            type: UNIT_ARTILLERY, image: 'assets/AFcongo.jpg'     },
  'card-southAfrica':      { id: 'card-southAfrica',      territory: 'southAfrica',      type: UNIT_ARTILLERY, image: 'assets/AFsouth.jpg'     },
  'card-yakutsk':          { id: 'card-yakutsk',          territory: 'yakutsk',          type: UNIT_ARTILLERY, image: 'assets/ASyakutsk.jpg'   },
  'card-kamchatka':        { id: 'card-kamchatka',        territory: 'kamchatka',        type: UNIT_ARTILLERY, image: 'assets/ASkamchatka.jpg' },
  'card-irkutsk':          { id: 'card-irkutsk',          territory: 'irkutsk',          type: UNIT_ARTILLERY, image: 'assets/ASirkutsk.jpg'   },
  'card-china':            { id: 'card-china',            territory: 'china',            type: UNIT_ARTILLERY, image: 'assets/ASchina.jpg'     },
  'card-middleEast':       { id: 'card-middleEast',       territory: 'middleEast',       type: UNIT_ARTILLERY, image: 'assets/ASmiddle.jpg'    },
  'card-westernAustralia': { id: 'card-westernAustralia', territory: 'westernAustralia', type: UNIT_ARTILLERY, image: 'assets/AUwest.jpg'      },

  // Wildcards (2)
  'card-wild-1': { id: 'card-wild-1', territory: null, type: UNIT_WILD, image: 'assets/wild1.jpg' },
  'card-wild-2': { id: 'card-wild-2', territory: null, type: UNIT_WILD, image: 'assets/wild2.jpg' }
};

function allCardIds() { return Object.keys(CARDS); }

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildShuffledDeck() { return shuffle(allCardIds()); }

function drawCard(deck, discardPile) {
  if (deck.length === 0 && discardPile.length > 0) {
    const reshuffled = shuffle(discardPile);
    deck.push(...reshuffled);
    discardPile.length = 0;
  }
  return deck.length > 0 ? deck.shift() : null;
}

function isValidTradeSet(cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length !== 3) return false;
  const cards = cardIds.map(id => CARDS[id]);
  if (cards.some(c => !c)) return false;
  const wildCount = cards.filter(c => c.type === UNIT_WILD).length;
  if (wildCount >= 1) return true;
  const distinct = new Set(cards.map(c => c.type));
  return distinct.size === 1 || distinct.size === 3;
}

function tradeSetValue(setNumber) {
  if (setNumber < 1) return 0;
  const table = [4, 6, 8, 10, 12, 15, 20, 25];
  if (setNumber <= table.length) return table[setNumber - 1];
  return 25 + (setNumber - 8) * 5;
}

function ownedTerritoriesInSet(cardIds, territoriesState, playerId) {
  return cardIds
    .map(id => CARDS[id])
    .filter(c => c && c.territory && territoriesState[c.territory] && territoriesState[c.territory].owner === playerId)
    .map(c => c.territory);
}

function handContainsValidSet(handCardIds) {
  if (!Array.isArray(handCardIds) || handCardIds.length < 3) return false;
  const n = handCardIds.length;
  for (let i = 0; i < n - 2; i++)
    for (let j = i + 1; j < n - 1; j++)
      for (let k = j + 1; k < n; k++)
        if (isValidTradeSet([handCardIds[i], handCardIds[j], handCardIds[k]])) return true;
  return false;
}

function tradeSetLabel(cardIds) {
  const types = cardIds.map(id => CARDS[id]?.type).filter(Boolean);
  const counts = { infantry: 0, cavalry: 0, artillery: 0, wild: 0 };
  types.forEach(t => { counts[t] = (counts[t] || 0) + 1; });

  if (counts.wild === 0) {
    if (counts.infantry === 3) return '3 × Infantry';
    if (counts.cavalry === 3) return '3 × Cavalry';
    if (counts.artillery === 3) return '3 × Artillery';
    if (counts.infantry === 1 && counts.cavalry === 1 && counts.artillery === 1) return '1 of each';
    return 'Mixed';
  }
  const nonWildTypes = types.filter(t => t !== UNIT_WILD);
  if (counts.wild === 3) return '3 × Wildcards';
  if (counts.wild === 2) return `2 × Wild + 1 × ${_capType(nonWildTypes[0])}`;
  const [a, b] = nonWildTypes;
  if (a === b) return `1 × Wild + 2 × ${_capType(a)}`;
  return `1 × Wild + 1 × ${_capType(a)} + 1 × ${_capType(b)}`;
}

function _capType(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
