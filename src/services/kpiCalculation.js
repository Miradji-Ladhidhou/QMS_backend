// Logique de calcul partagée entre l'application d'un import (routes/kpiImports.js) et la
// consultation a posteriori de la preuve derrière une valeur déjà calculée
// (routes/kpis.js, GET .../records/:recordId/proof et GET .../distribution) — une seule
// implémentation, pour ne jamais laisser les deux routes diverger sur "comment on calcule".

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

// Applique la recette de calcul (kpi_calculation_configs) à un groupe de lignes brutes
// (déjà réparties par période). Les 4 premiers types produisent une valeur unique
// destinée à kpi_records ; count_grouped produit une répartition, gardée à part.
export function computeGroup(config, rows) {
  const rowsTotal = rows.length;

  switch (config.calc_type) {
    case 'ratio': {
      const matching = rows.filter(({ rowData }) => {
        const value = rowData[config.filter_column];
        return String(value ?? '').trim().toLowerCase() === String(config.filter_value).trim().toLowerCase();
      }).length;
      return {
        value: rowsTotal > 0 ? Number(((matching / rowsTotal) * 100).toFixed(2)) : null,
        matching,
        rowsValid: rowsTotal,
        rejectedDetails: [],
      };
    }
    case 'sum':
    case 'average': {
      const numbers = [];
      const rejectedDetails = [];
      rows.forEach(({ rowIndex, rowData }) => {
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
      const value =
        numbers.length === 0
          ? null
          : config.calc_type === 'sum'
          ? Number(numbers.reduce((a, b) => a + b, 0).toFixed(2))
          : Number((numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(2));
      return { value, rowsValid: numbers.length, rejectedDetails };
    }
    case 'count': {
      return { value: rowsTotal, rowsValid: rowsTotal, rejectedDetails: [] };
    }
    case 'count_grouped': {
      const groupedCounts = {};
      rows.forEach(({ rowData }) => {
        const key = String(rowData[config.group_by_column] ?? '').trim() || '(vide)';
        groupedCounts[key] = (groupedCounts[key] || 0) + 1;
      });
      return { groupedCounts, rowsValid: rowsTotal, rejectedDetails: [] };
    }
    default:
      return { value: null, rowsValid: 0, rejectedDetails: [] };
  }
}

// Description en langage clair du calcul appliqué à un groupe de lignes, pour l'affichage
// de la "preuve" derrière une valeur (GET .../records/:recordId/proof).
export function describeCalculation(config, calcResult, groupSize, recordValue, unit) {
  const unitSuffix = unit ? ` ${unit}` : '';
  const plural = (n) => (n > 1 ? 's' : '');

  switch (config.calc_type) {
    case 'ratio':
      return `${recordValue}${unitSuffix} = ${calcResult.matching} ligne${plural(calcResult.matching)} où "${config.filter_column}" = "${config.filter_value}" sur ${groupSize} ligne${plural(groupSize)} au total.`;
    case 'sum':
      return `${recordValue}${unitSuffix} = somme de la colonne "${config.source_column}" sur ${calcResult.rowsValid} ligne${plural(calcResult.rowsValid)} valide${plural(calcResult.rowsValid)} sur ${groupSize}${calcResult.rejectedDetails.length > 0 ? `, ${calcResult.rejectedDetails.length} rejetée${plural(calcResult.rejectedDetails.length)}` : ''}.`;
    case 'average':
      return `${recordValue}${unitSuffix} = moyenne de la colonne "${config.source_column}" sur ${calcResult.rowsValid} ligne${plural(calcResult.rowsValid)} valide${plural(calcResult.rowsValid)} sur ${groupSize}${calcResult.rejectedDetails.length > 0 ? `, ${calcResult.rejectedDetails.length} rejetée${plural(calcResult.rejectedDetails.length)}` : ''}.`;
    case 'count':
      return `${recordValue}${unitSuffix} = nombre de lignes sur cette période.`;
    default:
      return `${recordValue}${unitSuffix}`;
  }
}
