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

  it('exports all series in an editable chart', async () => {
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
    expect(chart.match(/<c:ser>/g)).toHaveLength(2);
  });
});
