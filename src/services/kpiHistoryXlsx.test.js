import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { buildKpiHistoryXlsx } from './kpiHistoryXlsx.js';

const kpi = {
  name: 'Commandes',
  unit: '%',
  calculation_type: 'manual',
  frequency: 'monthly',
  target: 90,
  target_direction: 'min',
  calculation_configs: [],
};
const records = [
  { period_date: '2026-01-01', value: 80, source: 'manual' },
  { period_date: '2026-02-01', value: 95, source: 'manual' },
];

describe('KPI Excel export with native chart', () => {
  it.each([['line', 'lineChart'], ['bar', 'barChart']])('exports %s charts linked to all records', async (chartType, chartElement) => {
    const buffer = await buildKpiHistoryXlsx({ kpi, records, chartType });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Commandes');
    expect(sheet.getCell('C5').value).toBe(80);
    expect(sheet.getCell('C6').value).toBe(95);

    const zip = await JSZip.loadAsync(buffer);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart).toContain(`<c:${chartElement}>`);
    expect(chart).toContain('$C$5:$C$6');
    expect(zip.file('xl/drawings/drawing1.xml')).not.toBeNull();
  });

  it('exports all series in an editable chart, plus the KPI target line they follow', async () => {
    const buffer = await buildKpiHistoryXlsx({
      kpi: {
        ...kpi,
        calculation_configs: [
          { id: 'a', label: 'Ligne A' },
          { id: 'b', label: 'Ligne B' },
        ],
      },
      records: [
        { ...records[0], config_id: 'a' },
        { ...records[1], config_id: 'b' },
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart).toContain('Ligne A');
    expect(chart).toContain('Ligne B');
    // 2 séries de données + 1 ligne d'objectif (les deux séries suivent l'objectif du KPI).
    expect(chart.match(/<c:ser>/g)).toHaveLength(3);
    expect(chart).toContain('<c:tx><c:v>Objectif</c:v></c:tx>');
  });

  it('draws one dashed target line per custom series target', async () => {
    const buffer = await buildKpiHistoryXlsx({
      kpi: {
        ...kpi,
        calculation_configs: [
          { id: 'a', label: 'Ligne A', target: 70, target_direction: 'min' },
          { id: 'b', label: 'Ligne B' },
        ],
      },
      records: [
        { ...records[0], config_id: 'a' },
        { ...records[1], config_id: 'b' },
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    // Objectif propre à Ligne A + objectif du KPI (suivi par Ligne B).
    expect(chart).toContain('<c:tx><c:v>Objectif Ligne A</c:v></c:tx>');
    expect(chart).toContain('<c:tx><c:v>Objectif</c:v></c:tx>');
    expect(chart.match(/<c:ser>/g)).toHaveLength(4);
    // Trait plein (pas de pointillés), violet pour l'objectif du KPI.
    expect(chart).not.toContain('prstDash');
    expect(chart).toContain('<a:srgbClr val="7C3AED"/>');
  });

  it('keeps the chart free of target lines when the KPI has no target', async () => {
    const buffer = await buildKpiHistoryXlsx({
      kpi: { ...kpi, target: null },
      records,
    });
    const zip = await JSZip.loadAsync(buffer);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart.match(/<c:ser>/g)).toHaveLength(1);
    expect(chart).not.toContain('Objectif');
  });

  it('includes the target as a constant line series in a bar chart combo', async () => {
    const buffer = await buildKpiHistoryXlsx({ kpi, records, chartType: 'bar' });
    const zip = await JSZip.loadAsync(buffer);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart).toContain('<c:barChart>');
    // La cible reste une ligne : groupe lineChart séparé partageant les axes du barChart.
    expect(chart).toContain('<c:lineChart>');
    expect(chart).toContain('<c:tx><c:v>Objectif</c:v></c:tx>');
    expect((chart.match(/<c:pt idx="\d+"><c:v>90<\/c:v><\/c:pt>/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
