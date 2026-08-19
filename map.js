// map.js — Territory and continent data
// Coordinates are in the pixel space of assets/risk-map.png (800 × 533).

'use strict';

const CONTINENTS = {
  northAmerica: {
    id: 'northAmerica', name: 'North America', bonus: 5, color: '#c98a4b',
    territories: ['alaska', 'northwest', 'greenland', 'alberta', 'ontario', 'quebec', 'westernUs', 'easternUs', 'centralAmerica']
  },
  southAmerica: {
    id: 'southAmerica', name: 'South America', bonus: 2, color: '#d4b74a',
    territories: ['venezuela', 'peru', 'brazil', 'argentina']
  },
  europe: {
    id: 'europe', name: 'Europe', bonus: 5, color: '#8b7fc4',
    territories: ['iceland', 'greatBritain', 'westernEurope', 'northernEurope', 'scandinavia', 'southernEurope', 'ukraine']
  },
  africa: {
    id: 'africa', name: 'Africa', bonus: 3, color: '#b58c5b',
    territories: ['northAfrica', 'egypt', 'eastAfrica', 'congo', 'southAfrica', 'madagascar']
  },
  asia: {
    id: 'asia', name: 'Asia', bonus: 7, color: '#a8c47a',
    territories: ['ural', 'siberia', 'yakutsk', 'kamchatka', 'irkutsk', 'mongolia', 'japan', 'china', 'middleEast', 'india', 'siam', 'afghanistan']
  },
  australia: {
    id: 'australia', name: 'Australia', bonus: 2, color: '#c176c8',
    territories: ['indonesia', 'newGuinea', 'westernAustralia', 'easternAustralia']
  }
};

const TERRITORIES = {
  alaska:         { id: 'alaska',         name: 'Alaska',       continent: 'northAmerica', x:  40, y:  78, adjacent: ['northwest', 'alberta', 'kamchatka'] },
  northwest:      { id: 'northwest',      name: 'NW Territory', continent: 'northAmerica', x: 117, y:  78, adjacent: ['alaska', 'alberta', 'ontario', 'greenland'] },
  greenland:      { id: 'greenland',      name: 'Greenland',    continent: 'northAmerica', x: 268, y:  43, adjacent: ['northwest', 'ontario', 'quebec', 'iceland'] },
  alberta:        { id: 'alberta',        name: 'Alberta',      continent: 'northAmerica', x: 114, y: 129, adjacent: ['alaska', 'northwest', 'ontario', 'westernUs'] },
  ontario:        { id: 'ontario',        name: 'Ontario',      continent: 'northAmerica', x: 168, y: 133, adjacent: ['northwest', 'greenland', 'quebec', 'alberta', 'westernUs', 'easternUs'] },
  quebec:         { id: 'quebec',         name: 'Quebec',       continent: 'northAmerica', x: 223, y: 139, adjacent: ['greenland', 'ontario', 'easternUs'] },
  westernUs:      { id: 'westernUs',      name: 'Western US',   continent: 'northAmerica', x: 114, y: 182, adjacent: ['alberta', 'ontario', 'easternUs', 'centralAmerica'] },
  easternUs:      { id: 'easternUs',      name: 'Eastern US',   continent: 'northAmerica', x: 173, y: 206, adjacent: ['ontario', 'quebec', 'westernUs', 'centralAmerica'] },
  centralAmerica: { id: 'centralAmerica', name: 'C. America',   continent: 'northAmerica', x: 120, y: 256, adjacent: ['westernUs', 'easternUs', 'venezuela'] },

  venezuela: { id: 'venezuela', name: 'Venezuela', continent: 'southAmerica', x: 180, y: 302, adjacent: ['centralAmerica', 'peru', 'brazil'] },
  peru:      { id: 'peru',      name: 'Peru',      continent: 'southAmerica', x: 172, y: 368, adjacent: ['venezuela', 'brazil', 'argentina'] },
  brazil:    { id: 'brazil',    name: 'Brazil',    continent: 'southAmerica', x: 236, y: 356, adjacent: ['venezuela', 'peru', 'argentina', 'northAfrica'] },
  argentina: { id: 'argentina', name: 'Argentina', continent: 'southAmerica', x: 195, y: 434, adjacent: ['peru', 'brazil'] },

  iceland:        { id: 'iceland',        name: 'Iceland',     continent: 'europe', x: 334, y: 105, adjacent: ['greenland', 'greatBritain', 'scandinavia'] },
  greatBritain:   { id: 'greatBritain',   name: 'Gr. Britain', continent: 'europe', x: 322, y: 169, adjacent: ['iceland', 'westernEurope', 'northernEurope', 'scandinavia'] },
  westernEurope:  { id: 'westernEurope',  name: 'W. Europe',   continent: 'europe', x: 333, y: 240, adjacent: ['greatBritain', 'northernEurope', 'southernEurope', 'northAfrica'] },
  northernEurope: { id: 'northernEurope', name: 'N. Europe',   continent: 'europe', x: 399, y: 179, adjacent: ['greatBritain', 'westernEurope', 'scandinavia', 'southernEurope', 'ukraine'] },
  scandinavia:    { id: 'scandinavia',    name: 'Scandinavia', continent: 'europe', x: 410, y:  91, adjacent: ['iceland', 'greatBritain', 'northernEurope', 'ukraine'] },
  southernEurope: { id: 'southernEurope', name: 'S. Europe',   continent: 'europe', x: 397, y: 222, adjacent: ['westernEurope', 'northernEurope', 'ukraine', 'egypt', 'northAfrica', 'middleEast'] },
  ukraine:        { id: 'ukraine',        name: 'Ukraine',     continent: 'europe', x: 472, y: 142, adjacent: ['northernEurope', 'scandinavia', 'southernEurope', 'ural', 'afghanistan', 'middleEast'] },

  northAfrica: { id: 'northAfrica', name: 'N. Africa',  continent: 'africa', x: 353, y: 340, adjacent: ['westernEurope', 'southernEurope', 'brazil', 'egypt', 'eastAfrica', 'congo'] },
  egypt:       { id: 'egypt',       name: 'Egypt',      continent: 'africa', x: 425, y: 313, adjacent: ['southernEurope', 'middleEast', 'northAfrica', 'eastAfrica'] },
  eastAfrica:  { id: 'eastAfrica',  name: 'E. Africa',  continent: 'africa', x: 460, y: 373, adjacent: ['egypt', 'northAfrica', 'congo', 'southAfrica', 'madagascar', 'middleEast'] },
  congo:       { id: 'congo',       name: 'Congo',      continent: 'africa', x: 425, y: 405, adjacent: ['northAfrica', 'eastAfrica', 'southAfrica'] },
  southAfrica: { id: 'southAfrica', name: 'S. Africa',  continent: 'africa', x: 429, y: 471, adjacent: ['congo', 'eastAfrica', 'madagascar'] },
  madagascar:  { id: 'madagascar',  name: 'Madagascar', continent: 'africa', x: 504, y: 478, adjacent: ['eastAfrica', 'southAfrica'] },

  ural:        { id: 'ural',        name: 'Ural',        continent: 'asia', x: 550, y: 131, adjacent: ['ukraine', 'afghanistan', 'china', 'siberia'] },
  siberia:     { id: 'siberia',     name: 'Siberia',     continent: 'asia', x: 594, y:  80, adjacent: ['ural', 'yakutsk', 'irkutsk', 'mongolia', 'china'] },
  yakutsk:     { id: 'yakutsk',     name: 'Yakutsk',     continent: 'asia', x: 651, y:  67, adjacent: ['siberia', 'kamchatka', 'irkutsk'] },
  kamchatka:   { id: 'kamchatka',   name: 'Kamchatka',   continent: 'asia', x: 722, y:  66, adjacent: ['yakutsk', 'irkutsk', 'mongolia', 'japan', 'alaska'] },
  irkutsk:     { id: 'irkutsk',     name: 'Irkutsk',     continent: 'asia', x: 638, y: 133, adjacent: ['siberia', 'yakutsk', 'kamchatka', 'mongolia'] },
  mongolia:    { id: 'mongolia',    name: 'Mongolia',    continent: 'asia', x: 658, y: 181, adjacent: ['siberia', 'irkutsk', 'kamchatka', 'japan', 'china'] },
  japan:       { id: 'japan',       name: 'Japan',       continent: 'asia', x: 745, y: 175, adjacent: ['kamchatka', 'mongolia'] },
  china:       { id: 'china',       name: 'China',       continent: 'asia', x: 618, y: 231, adjacent: ['ural', 'siberia', 'mongolia', 'siam', 'india', 'afghanistan'] },
  middleEast:  { id: 'middleEast',  name: 'Middle East', continent: 'asia', x: 489, y: 269, adjacent: ['southernEurope', 'ukraine', 'afghanistan', 'india', 'eastAfrica', 'egypt'] },
  india:       { id: 'india',       name: 'India',       continent: 'asia', x: 581, y: 280, adjacent: ['afghanistan', 'china', 'middleEast', 'siam'] },
  siam:        { id: 'siam',        name: 'Siam',        continent: 'asia', x: 650, y: 302, adjacent: ['china', 'india', 'indonesia'] },
  afghanistan: { id: 'afghanistan', name: 'Afghanistan', continent: 'asia', x: 542, y: 197, adjacent: ['ukraine', 'ural', 'china', 'india', 'middleEast'] },

  indonesia:        { id: 'indonesia',        name: 'Indonesia',    continent: 'australia', x: 663, y: 390, adjacent: ['siam', 'newGuinea', 'westernAustralia'] },
  newGuinea:        { id: 'newGuinea',        name: 'New Guinea',   continent: 'australia', x: 729, y: 370, adjacent: ['indonesia', 'westernAustralia', 'easternAustralia'] },
  westernAustralia: { id: 'westernAustralia', name: 'W. Australia', continent: 'australia', x: 688, y: 473, adjacent: ['indonesia', 'newGuinea', 'easternAustralia'] },
  easternAustralia: { id: 'easternAustralia', name: 'E. Australia', continent: 'australia', x: 760, y: 462, adjacent: ['newGuinea', 'westernAustralia'] }
};
