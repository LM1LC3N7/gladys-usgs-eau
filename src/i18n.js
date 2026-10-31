// -----------------------------------------------------------------------------
// Runtime texts. The connection status is multi-language ({ en, fr }, Gladys
// picks); the names given in Discovery and the status texts of the devices
// are in the language of the form (`language`): one string per state.
// -----------------------------------------------------------------------------

import { MAX_STATUS_LENGTH } from './constants.js';

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
const bound = (text) =>
  text.length > MAX_STATUS_LENGTH ? `${text.slice(0, MAX_STATUS_LENGTH - 1)}…` : text;

/** Feature names, by language and key. */
export const FEATURE_NAMES = {
  en: {
    'discharge-cfs': 'Discharge (ft³/s)',
    'discharge-m3s': 'Discharge (m³/s)',
    'gage-height-ft': 'Gage height',
    'gage-height-m': 'Gage height',
    'water-temperature-f': 'Water temperature',
    'water-temperature-c': 'Water temperature',
    'groundwater-depth-ft': 'Depth to water below land surface',
    'groundwater-depth-m': 'Depth to water below land surface',
    status: 'Status',
  },
  fr: {
    'discharge-cfs': 'Débit (pi³/s)',
    'discharge-m3s': 'Débit (m³/s)',
    'gage-height-ft': "Hauteur à l'échelle",
    'gage-height-m': "Hauteur à l'échelle",
    'water-temperature-f': "Température de l'eau",
    'water-temperature-c': "Température de l'eau",
    'groundwater-depth-ft': 'Profondeur de la nappe sous le sol',
    'groundwater-depth-m': 'Profondeur de la nappe sous le sol',
    status: 'État',
  },
};

/** Short kind names, for the status texts. */
const KIND_NAMES = {
  en: {
    discharge: 'discharge',
    'gage-height': 'gage height',
    'water-temperature': 'temperature',
    'groundwater-depth': 'water depth',
  },
  fr: {
    discharge: 'débit',
    'gage-height': 'hauteur',
    'water-temperature': 'température',
    'groundwater-depth': 'profondeur de nappe',
  },
};

/**
 * The qualifier codes of the USGS, as the real service sends them (every one
 * seen on 2026-10-30, test/fixtures/qualifiers.json); any other is shown as
 * its code.
 */
const QUALIFIERS = new Map([
  ['BACKWATER', { en: 'backwater', fr: 'remous' }],
  ['BLWMIN', { en: 'below the minimum measurable', fr: 'sous le minimum mesurable' }],
  ['DAMFAILURE', { en: 'dam failure', fr: 'rupture de barrage' }],
  ['DEBRIS', { en: 'debris', fr: 'débris' }],
  ['DIFFDATUM', { en: 'other datum', fr: 'autre référence de niveau' }],
  ['DISCONTINUED', { en: 'discontinued', fr: 'arrêtée' }],
  ['DRY', { en: 'dry', fr: 'à sec' }],
  ['EQUIP', { en: 'equipment malfunction', fr: "panne d'équipement" }],
  ['ESTIMATED', { en: 'estimated', fr: 'estimée' }],
  ['FLOOD', { en: 'flood damage', fr: 'dégâts de crue' }],
  ['FORCEINTERPOLATION', { en: 'interpolated', fr: 'interpolée' }],
  [
    'GHNOTASSCPKQ',
    { en: 'gage height not tied to the peak flow', fr: 'hauteur non liée au débit de pointe' },
  ],
  ['GREATERTHAN', { en: 'greater than the value', fr: 'supérieure à la valeur' }],
  ['ICE', { en: 'ice', fr: 'glace' }],
  ['LESSTHAN', { en: 'less than the value', fr: 'inférieure à la valeur' }],
  ['MAINT', { en: 'maintenance', fr: 'maintenance' }],
  ['OPPORTUNISTIC', { en: 'occasional measurement', fr: 'mesure ponctuelle' }],
  ['OTHERAGENCY', { en: 'from another agency', fr: "d'une autre agence" }],
  ['RATINGDEV', { en: 'rating being developed', fr: 'courbe de tarage en cours' }],
  ['REGULATED', { en: 'regulated', fr: 'régulé' }],
  ['REVISED', { en: 'revised', fr: 'révisée' }],
  ['SEASONAL', { en: 'off season', fr: 'hors saison' }],
  ['TEST', { en: 'test', fr: 'test' }],
  ['TIDE', { en: 'tide', fr: 'marée' }],
  ['UNAVAIL', { en: 'unavailable', fr: 'indisponible' }],
  ['URBAN', { en: 'urban influence', fr: 'influence urbaine' }],
  ['ZEROFLOW', { en: 'zero flow', fr: 'débit nul' }],
]);

export const QUALIFIER_CODES = [...QUALIFIERS.keys()];

export function qualifierText(language, codes) {
  if (!codes || codes.length === 0)
    return language === 'fr' ? 'sans raison donnée' : 'no reason given';
  return codes.map((code) => QUALIFIERS.get(code)?.[language] ?? code).join(', ');
}

const formatters = new Map();
/** An instant in the time zone of the station: "Oct 30, 1:50 AM EDT" / "30 oct., 01:50 UTC−4". */
export function stationTime(language, at, zone) {
  const key = `${language}|${zone}`;
  let format = formatters.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', {
        timeZone: zone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
    } catch {
      return stationTime(language, at, 'UTC');
    }
    formatters.set(key, format);
  }
  return format.format(new Date(at));
}

/**
 * The status text of a station.
 * @param {{ code: string, time?: number, zone: string, behind?: string[], qualifiers?: string[] }} view
 */
export function deviceStatus(language, view) {
  const fr = language === 'fr';
  const lang = fr ? 'fr' : 'en';
  const t = view.time === undefined ? '' : stationTime(language, view.time, view.zone);
  const kinds = (view.behind ?? [])
    .map(({ kind, qualifiers }) =>
      qualifiers.length > 0
        ? `${KIND_NAMES[lang][kind]} (${qualifierText(lang, qualifiers)})`
        : KIND_NAMES[lang][kind],
    )
    .join(', ');
  // What the USGS says of the values published: estimated, revised... and provisional.
  const notes = (view.flags ?? []).map((code) => qualifierText(lang, [code]));
  if (view.provisional) notes.push(fr ? 'provisoire' : 'provisional');
  const flags = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  switch (view.code) {
    case 'ok':
      return bound(
        fr
          ? `Mesuré le ${t}${flags}${kinds ? ` ; pas à jour : ${kinds}` : ''}`
          : `Measured ${t}${flags}${kinds ? `; not current: ${kinds}` : ''}`,
      );
    case 'novalue':
      return bound(
        fr
          ? `Sans valeur (${qualifierText('fr', view.qualifiers)}), le ${t}`
          : `No value (${qualifierText('en', view.qualifiers)}), ${t}`,
      );
    case 'stale':
      return bound(
        fr ? `Aucune valeur récente ; dernière le ${t}` : `No current value; last one ${t}`,
      );
    case 'unreadable':
      return fr ? 'Valeur illisible à la source' : 'Unreadable value at the source';
    case 'unknown':
      return fr ? 'Station inconnue de l’USGS' : 'Station unknown to the USGS';
    default:
      return fr ? 'Aucune donnée en continu à cette station' : 'No continuous data at this station';
  }
}

/** Joins status parts ({ en, fr } each) into one bounded message. */
export function joinMessages(parts) {
  if (parts.length === 0) return undefined;
  const join = (lang) => parts.map((p) => p[lang]).join(' ');
  return { en: join('en'), fr: join('fr') };
}

const clock = (lang, wall) => stationTime(lang, wall, 'UTC');

/** Why a request failed, by FetchError code (+ status). */
export function failureText(outcome) {
  switch (outcome.code) {
    case 'rate_limited':
      return { en: 'too many requests', fr: 'trop de requêtes' };
    case 'server':
      return {
        en: `service unavailable (HTTP ${outcome.status})`,
        fr: `service indisponible (HTTP ${outcome.status})`,
      };
    case 'http':
      return {
        en: `refused (HTTP ${outcome.status})`,
        fr: `refusé (HTTP ${outcome.status})`,
      };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'too_large':
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case 'format':
    case 'encoding':
    case 'redirect':
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case 'incomplete':
      return { en: 'answer incomplete', fr: 'réponse incomplète' };
    default:
      return { en: 'network error', fr: 'erreur réseau' };
  }
}

export const T = {
  configUnread: (wait) => ({
    en: `The configuration could not be read from Gladys: new try in ${minutes(wait)} min.`,
    fr: `La configuration n'a pas pu être lue depuis Gladys : nouvel essai dans ${minutes(wait)} min.`,
  }),
  noStation: {
    en: 'No station: type USGS station numbers in the configuration (the "Search stations" button finds them).',
    fr: 'Aucune station : saisissez des numéros de stations USGS dans la configuration (le bouton « Chercher des stations » les trouve).',
  },
  waiting: (left) => ({
    en: `Waiting for the first read (in ${minutes(left)} min at most).`,
    fr: `En attente de la première lecture (dans ${minutes(left)} min au plus).`,
  }),
  ok: (stations, fresh) => ({
    en: `${stations} station(s) read, ${fresh} with a current value.`,
    fr: `${stations} station(s) lue(s), ${fresh} avec une valeur récente.`,
  }),
  noneCurrent: (stations) => ({
    en: `The USGS answers, but none of the ${stations} station(s) has a current value: nothing is published.`,
    fr: `L'USGS répond, mais aucune des ${stations} station(s) n'a de valeur récente : rien n'est publié.`,
  }),
  failed: (outcome) => {
    const why = failureText(outcome);
    return {
      en: `Last read failed (${why.en}): nothing new is published, a value older than the maximum age is no longer current.`,
      fr: `La dernière lecture a échoué (${why.fr}) : rien de nouveau n'est publié, une valeur plus ancienne que l'ancienneté maximale n'est plus récente.`,
    };
  },
  paused: (outcome, until) => {
    const why = failureText(outcome);
    if (outcome.code === 'server') {
      return {
        en: `The USGS is unavailable (${why.en}): reads paused until ${clock('en', until)}; nothing new meanwhile.`,
        fr: `L'USGS est indisponible (${why.fr}) : lectures en pause jusqu'à ${clock('fr', until)} ; rien de nouveau d'ici là.`,
      };
    }
    return {
      en: `The USGS asked to slow down (${why.en}): paused until ${clock('en', until)}; nothing new meanwhile.`,
      fr: `L'USGS a demandé de ralentir (${why.fr}) : en pause jusqu'à ${clock('fr', until)} ; rien de nouveau d'ici là.`,
    };
  },
  meta: (outcome) => {
    const why = failureText(outcome);
    return {
      en: `Station names not read (${why.en}): ids shown, times in UTC.`,
      fr: `Noms des stations non lus (${why.fr}) : numéros affichés, heures en UTC.`,
    };
  },
  flagged: (n) => ({
    en: `${n} station(s) with values the USGS qualifies (estimated, revised...): see their status.`,
    fr: `${n} station(s) dont l'USGS qualifie les valeurs (estimées, révisées…) : voir leur état.`,
  }),
  unknown: (n) => ({
    en: `${n} station(s) unknown to the USGS.`,
    fr: `${n} station(s) inconnue(s) de l'USGS.`,
  }),
  budget: {
    en: 'Some values wait for the next read (Gladys accepts 300 states a minute).',
    fr: 'Certaines valeurs attendent la prochaine lecture (Gladys accepte 300 états par minute).',
  },
  searchEmpty: {
    en: 'Type a word of the station name (river, town...): letters and digits only.',
    fr: 'Tapez un mot du nom de la station (rivière, ville…) : lettres et chiffres seulement.',
  },
  searchPaused: (until) => ({
    en: `The USGS asked to slow down: no search until ${clock('en', until)}.`,
    fr: `L'USGS a demandé de ralentir : pas de recherche avant ${clock('fr', until)}.`,
  }),
  searchWait: (left) => ({
    en: `One search at a time: try again in ${Math.max(1, Math.ceil(left / 1000))} s.`,
    fr: `Une recherche à la fois : réessayez dans ${Math.max(1, Math.ceil(left / 1000))} s.`,
  }),
  searchBusy: {
    en: 'A read of the stations is running: try again in a minute.',
    fr: 'Une lecture des stations est en cours : réessayez dans une minute.',
  },
  searchFailed: (outcome) => {
    const why = failureText(outcome);
    return { en: `Search failed (${why.en}).`, fr: `La recherche a échoué (${why.fr}).` };
  },
  searchNone: (words) => ({
    en: `No USGS station name holds "${words}".`,
    fr: `Aucun nom de station USGS ne contient « ${words} ».`,
  }),
  searchResults: (rows, more) => {
    const lines = rows.map((r) => `${r.id.replace(/^USGS-/, '')}: ${r.text}`);
    return {
      en: [
        'Copy the number into "Stations":',
        ...lines,
        ...(more ? ['… and more: add a word.'] : []),
      ].join('\n'),
      fr: [
        'Copiez le numéro dans « Stations » :',
        ...lines,
        ...(more ? ['… et d’autres : ajoutez un mot.'] : []),
      ].join('\n'),
    };
  },
  dataUnreadable: {
    en: 'The state file in /data could not be read: set aside, values seen first are not sent again.',
    fr: "Le fichier d'état de /data n'a pas pu être lu : mis de côté, les premières valeurs vues ne sont pas renvoyées.",
  },
  dataUnwritable: {
    en: '/data cannot be written: the pace and the values sent are not kept across a restart.',
    fr: "/data n'est pas inscriptible : le rythme et les valeurs envoyées ne survivent pas à un redémarrage.",
  },
  notes: {
    stations_invalid: {
      en: 'Some station entries are not USGS station numbers and were ignored.',
      fr: 'Certaines stations saisies ne sont pas des numéros USGS et ont été ignorées.',
    },
    stations_cut: {
      en: 'Only the first 20 stations are read.',
      fr: 'Seules les 20 premières stations sont lues.',
    },
    units: {
      en: 'Unknown unit system: U.S. units used.',
      fr: "Système d'unités inconnu : unités américaines utilisées.",
    },
    language: {
      en: 'Unknown language: English used.',
      fr: 'Langue inconnue : anglais utilisé.',
    },
    interval: {
      en: 'Read interval out of range (15 to 120 min): replaced.',
      fr: 'Intervalle de lecture hors limites (15 à 120 min) : remplacé.',
    },
    max_age: {
      en: 'Maximum age out of range (1 to 48 h): replaced.',
      fr: 'Ancienneté maximale hors limites (1 à 48 h) : remplacée.',
    },
  },
};
