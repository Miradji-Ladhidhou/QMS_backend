// Logique de calcul partagée entre l'application d'un import (routes/kpiImports.js), son
// aperçu live sans persistance (POST /api/kpi-imports/:importId/evaluate), et la
// consultation a posteriori de la preuve derrière une valeur déjà calculée
// (routes/kpis.js, GET .../records/:recordId/proof et GET .../distribution) — une seule
// implémentation, pour ne jamais laisser ces routes diverger sur "comment on calcule".

// Tente de convertir une valeur de colonne "période" en date yyyy-MM-dd : ISO tel quel,
// yyyy-MM ramené au 1er du mois, jj/mm/aaaa (format FR courant dans les exports Excel), ou
// tout ce que Date.parse sait lire nativement. Retourne null si rien ne correspond — la
// ligne est alors groupée par sa valeur brute plutôt que rejetée (cf. computeGroup ci-dessous).
export function normalizeAnyDate(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}$/.test(str)) return `${str}-01`;
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

// Tolère la virgule décimale FR ("12,5") tant qu'il n'y a pas déjà de point.
export function toNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  let str = String(raw).trim();
  if (!str) return NaN;
  if (str.includes(',') && !str.includes('.')) str = str.replace(',', '.');
  return Number(str);
}

// Groupe des lignes brutes ({ rowIndex, rowData }) par période : par valeur (normalisée en
// date si possible) de periodColumn, ou par une période unique fournie manuellement si le
// fichier ne porte pas lui-même de colonne de date. Une clé "__raw__:<valeur>" signale une
// valeur de période non convertible en date (groupée quand même, jamais rejetée).
export function groupRowsByPeriod(rawRows, periodColumn, manualPeriodDate) {
  const groups = new Map();
  for (const { row_index: rowIndex, row_data: rowData } of rawRows) {
    let key;
    if (periodColumn) {
      const raw = rowData[periodColumn];
      const normalized = normalizeAnyDate(raw);
      key = normalized || `__raw__:${String(raw ?? '').trim() || '(vide)'}`;
    } else {
      key = manualPeriodDate;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rowIndex, rowData });
  }
  return groups;
}

export const FILTER_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'is_empty',
  'is_not_empty',
];

const OPERATOR_LABELS = {
  equals: 'égal à',
  not_equals: 'différent de',
  contains: 'contient',
  not_contains: 'ne contient pas',
  greater_than: 'supérieur à',
  greater_or_equal: 'supérieur ou égal à',
  less_than: 'inférieur à',
  less_or_equal: 'inférieur ou égal à',
  is_empty: 'est vide',
  is_not_empty: "n'est pas vide",
};

// Évalue une condition ({column, operator, value}) sur une ligne brute. Les opérateurs
// numériques comparent via toNumber (donc tolèrent la virgule décimale FR) et sont faux si
// la valeur de la ligne ou de la condition n'est pas numérique — jamais une exception.
function evaluateFilter(rowData, filter) {
  const raw = rowData[filter.column];
  const strVal = String(raw ?? '').trim();

  switch (filter.operator) {
    case 'equals':
      return strVal.toLowerCase() === String(filter.value ?? '').trim().toLowerCase();
    case 'not_equals':
      return strVal.toLowerCase() !== String(filter.value ?? '').trim().toLowerCase();
    case 'contains':
      return strVal.toLowerCase().includes(String(filter.value ?? '').trim().toLowerCase());
    case 'not_contains':
      return !strVal.toLowerCase().includes(String(filter.value ?? '').trim().toLowerCase());
    case 'is_empty':
      return strVal === '';
    case 'is_not_empty':
      return strVal !== '';
    case 'greater_than':
    case 'greater_or_equal':
    case 'less_than':
    case 'less_or_equal': {
      const num = toNumber(raw);
      const target = toNumber(filter.value);
      if (Number.isNaN(num) || Number.isNaN(target)) return false;
      if (filter.operator === 'greater_than') return num > target;
      if (filter.operator === 'greater_or_equal') return num >= target;
      if (filter.operator === 'less_than') return num < target;
      return num <= target;
    }
    default:
      return false;
  }
}

// Combine toutes les conditions d'une recette selon filter_logic : 'all' (ET, par défaut)
// exige qu'elles soient toutes vraies, 'any' (OU) qu'au moins une le soit. Sans condition,
// toutes les lignes du groupe passent (comportement historique de sum/average/count/
// count_grouped avant l'introduction des filtres).
export function matchesFilters(rowData, filters, logic) {
  if (!filters || filters.length === 0) return true;
  const results = filters.map((filter) => evaluateFilter(rowData, filter));
  return logic === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// Applique la recette de calcul (kpi_calculation_configs) à un groupe de lignes brutes
// (déjà réparties par période) : filtre d'abord les lignes retenues (filters/filter_logic),
// puis agrège selon calc_type. ratio compare le nombre de lignes retenues au total du
// groupe ; sum/average/min/max agrègent source_column sur les lignes retenues ; count
// compte les lignes retenues ; count_grouped les répartit par group_by_column. Filtres et
// agrégation sont désormais indépendants : n'importe quel calc_type peut être restreint par
// des conditions, pas seulement ratio.
export function computeGroup(config, rows) {
  const rowsTotal = rows.length;
  const filters = config.filters || [];
  const logic = config.filter_logic || 'all';
  const matched = rows.filter(({ rowData }) => matchesFilters(rowData, filters, logic));

  switch (config.calc_type) {
    case 'ratio': {
      return {
        value: rowsTotal > 0 ? Number(((matched.length / rowsTotal) * 100).toFixed(2)) : null,
        matching: matched.length,
        rowsValid: rowsTotal,
        rejectedDetails: [],
      };
    }
    case 'count': {
      return { value: matched.length, rowsValid: matched.length, rejectedDetails: [] };
    }
    case 'sum':
    case 'average':
    case 'min':
    case 'max': {
      const numbers = [];
      const rejectedDetails = [];
      matched.forEach(({ rowIndex, rowData }) => {
        const num = toNumber(rowData[config.source_column]);
        if (Number.isNaN(num)) {
          rejectedDetails.push({
            row_index: rowIndex,
            reason: `Valeur non numérique dans "${config.source_column}" ("${rowData[config.source_column]}").`,
          });
        } else {
          numbers.push(num);
        }
      });
      let value = null;
      if (numbers.length > 0) {
        if (config.calc_type === 'sum') value = Number(numbers.reduce((a, b) => a + b, 0).toFixed(2));
        else if (config.calc_type === 'average') value = Number((numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(2));
        else if (config.calc_type === 'min') value = Number(Math.min(...numbers).toFixed(2));
        else value = Number(Math.max(...numbers).toFixed(2));
      }
      return { value, rowsValid: numbers.length, rejectedDetails };
    }
    case 'count_grouped': {
      const groupedCounts = {};
      matched.forEach(({ rowData }) => {
        const key = String(rowData[config.group_by_column] ?? '').trim() || '(vide)';
        groupedCounts[key] = (groupedCounts[key] || 0) + 1;
      });
      return { groupedCounts, rowsValid: matched.length, rejectedDetails: [] };
    }
    default:
      return { value: null, rowsValid: 0, rejectedDetails: [] };
  }
}

// Valide la forme d'un tableau de conditions envoyé par le frontend (POST .../calculation-config
// et POST .../evaluate) : chaque condition doit avoir une colonne, un opérateur connu, et une
// valeur sauf pour is_empty/is_not_empty. Retourne un message d'erreur ou null si valide.
export function validateFilters(filters) {
  if (!Array.isArray(filters)) return 'filters doit être un tableau.';
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') return 'Chaque condition doit être un objet.';
    if (!filter.column || typeof filter.column !== 'string') return 'Chaque condition doit préciser une colonne.';
    if (!FILTER_OPERATORS.includes(filter.operator)) return `Opérateur de condition invalide : "${filter.operator}".`;
    const needsValue = filter.operator !== 'is_empty' && filter.operator !== 'is_not_empty';
    if (needsValue && (filter.value === undefined || filter.value === null || filter.value === '')) {
      return `La condition sur "${filter.column}" nécessite une valeur.`;
    }
  }
  return null;
}

// Calcule le résultat de chaque groupe de période et le met en forme pour l'API : utilisé
// à la fois par l'application réelle d'un import (POST .../apply, qui upsert ensuite les
// périodes "persisted") et son aperçu sans écriture (POST .../evaluate) — même mise en
// forme, pour que le frontend affiche l'un et l'autre avec le même composant.
export function summarizeGroups(config, groups) {
  const periods = [];
  let rowsProcessed = 0;
  let rowsRejected = 0;

  for (const [periodKey, groupRows] of groups.entries()) {
    const isRawFallback = periodKey.startsWith('__raw__:');
    const periodDate = isRawFallback ? null : periodKey;
    const periodLabel = isRawFallback ? periodKey.slice('__raw__:'.length) : periodKey;

    const result = computeGroup(config, groupRows);
    rowsProcessed += groupRows.length;
    rowsRejected += result.rejectedDetails?.length || 0;

    if (config.calc_type === 'count_grouped') {
      periods.push({
        period_label: periodLabel,
        period_date: periodDate,
        persisted: false,
        grouped_counts: result.groupedCounts,
        rows_total: groupRows.length,
      });
      continue;
    }

    const persisted = periodDate !== null && result.value !== null;
    periods.push({
      period_label: periodLabel,
      period_date: periodDate,
      persisted,
      value: result.value,
      rows_total: groupRows.length,
      rows_valid: result.rowsValid,
      rows_rejected: result.rejectedDetails.length,
      rejected_details: result.rejectedDetails,
      ...(persisted
        ? {}
        : {
            skip_reason:
              periodDate === null
                ? "Valeur de période non convertible en date : résultat calculé mais non enregistré dans l'historique."
                : 'Aucune valeur numérique valide dans ce groupe.',
          }),
    });
  }

  return { periods, rowsProcessed, rowsRejected };
}

function describeFilters(filters, logic) {
  if (!filters || filters.length === 0) return null;
  const parts = filters.map((filter) => {
    const opLabel = OPERATOR_LABELS[filter.operator] || filter.operator;
    if (filter.operator === 'is_empty' || filter.operator === 'is_not_empty') {
      return `"${filter.column}" ${opLabel}`;
    }
    return `"${filter.column}" ${opLabel} "${filter.value}"`;
  });
  return parts.join(logic === 'any' ? ' OU ' : ' ET ');
}

// Description en langage clair du calcul appliqué à un groupe de lignes, pour l'affichage
// de la "preuve" derrière une valeur (GET .../records/:recordId/proof) et l'aperçu live
// (POST .../evaluate).
export function describeCalculation(config, calcResult, groupSize, recordValue, unit) {
  const unitSuffix = unit ? ` ${unit}` : '';
  const plural = (n) => (n > 1 ? 's' : '');
  const filterDescription = describeFilters(config.filters, config.filter_logic);
  // Toujours en incise séparée par une virgule, qu'il y ait ou non un autre détail
  // (rejets...) déjà présent en fin de phrase.
  const filterClause = filterDescription ? `, correspondant à : ${filterDescription}` : '';

  const aggregationLabel = { sum: 'somme', average: 'moyenne', min: 'minimum', max: 'maximum' }[config.calc_type];

  switch (config.calc_type) {
    case 'ratio':
      return `${recordValue}${unitSuffix} = ${calcResult.matching} ligne${plural(calcResult.matching)} sur ${groupSize} ligne${plural(groupSize)} au total${filterClause}.`;
    case 'sum':
    case 'average':
    case 'min':
    case 'max': {
      const rejectedClause =
        calcResult.rejectedDetails.length > 0
          ? `, ${calcResult.rejectedDetails.length} rejetée${plural(calcResult.rejectedDetails.length)}`
          : '';
      return `${recordValue}${unitSuffix} = ${aggregationLabel} de la colonne "${config.source_column}" sur ${calcResult.rowsValid} ligne${plural(calcResult.rowsValid)} valide${plural(calcResult.rowsValid)} sur ${groupSize}${filterClause}${rejectedClause}.`;
    }
    case 'count':
      return `${recordValue}${unitSuffix} = nombre de lignes sur cette période${filterClause}.`;
    default:
      return `${recordValue}${unitSuffix}`;
  }
}
