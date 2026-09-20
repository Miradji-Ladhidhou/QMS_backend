import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildKpiReportPdf, buildSeriesInfo, resolveSeriesSettings } from './kpiReportPdf.js';
import { buildKpiReportXlsx } from './kpiReportXlsx.js';

// KPI global "% ≥ 95" avec deux séries : "Conformes" suit le KPI, "Délai" est paramétrée à part
// (heures, ≤ 24).
const KPI = {
  id: 'k1',
  name: 'Contrôle de commandes',
  unit: '%',
  target: 95,
  target_direction: 'min',
  calculation_type: 'manual',
  folder: null,
  calculation_configs: [
    { id: 'c1', label: 'Conformes', calc_type: 'manual', unit: null, target: null, target_direction: null },
    { id: 'c2', label: 'Délai', calc_type: 'manual', unit: 'heures', target: 24, target_direction: 'max' },
  ],
  records: [
    { id: 'r1', config_id: 'c1', period_date: '2026-01-01', value: 96, source: 'manual' },
    { id: 'r2', config_id: 'c1', period_date: '2026-02-01', value: 97, source: 'manual' },
    { id: 'r3', config_id: 'c2', period_date: '2026-01-01', value: 20, source: 'manual' },
    { id: 'r4', config_id: 'c2', period_date: '2026-02-01', value: 30, source: 'manual' },
  ],
};

describe('resolveSeriesSettings', () => {
  it('reprend le KPI pour une série non paramétrée, les siennes sinon', () => {
    expect(resolveSeriesSettings(KPI, KPI.calculation_configs[0])).toEqual({ unit: '%', target: 95, direction: 'min', custom: false });
    expect(resolveSeriesSettings(KPI, KPI.calculation_configs[1])).toEqual({ unit: 'heures', target: 24, direction: 'max', custom: true });
  });

  it('une cible propre à 0 reste une cible (pas confondue avec "aucune")', () => {
    const settings = resolveSeriesSettings(KPI, { target_direction: 'max', unit: 'accidents', target: 0 });
    expect(settings).toMatchObject({ target: 0, custom: true });
  });

  it('buildSeriesInfo expose les paramètres effectifs de chaque série', () => {
    const { showMultiSeries, seriesList } = buildSeriesInfo(KPI);
    expect(showMultiSeries).toBe(true);
    expect(seriesList.map((s) => s.settings.unit)).toEqual(['%', 'heures']);
  });
});

describe('exports KPI avec séries paramétrées', () => {
  it('PDF valide (rangée de moyennes + lignes d\'objectif par série)', async () => {
    const buffer = await buildKpiReportPdf({ tenantName: 'Test', tenantLogo: null, kpis: [KPI], detailStatsByKpi: {} });
    expect(Buffer.from(buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('Excel : la feuille Détail porte l\'unité et l\'objectif de chaque série', async () => {
    const buffer = await buildKpiReportXlsx({ kpis: [KPI] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Détail');
    const byValue = new Map();
    sheet.eachRow((row, index) => {
      if (index > 2) byValue.set(row.getCell(5).value, { unit: row.getCell(8).value, target: row.getCell(9).value });
    });
    expect(byValue.get(96)).toEqual({ unit: '%', target: '>= 95 %' });
    expect(byValue.get(30)).toEqual({ unit: 'heures', target: '<= 24 heures' });
  });
});
