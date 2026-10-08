import { describe, expect, it } from 'vitest';
import { buildEvidenceRecordPdf, buildEvidenceRecordWord } from './evidenceRecordReport.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

describe('exports des fiches avec photos de preuve', () => {
  const report = {
    tenantName: 'Entreprise de test',
    title: 'Fiche de non-conformité',
    facts: [{ label: 'Statut', value: 'Ouverte' }],
    sections: [{ title: 'Description', content: 'Défaut observé.' }],
    evidence: [{ buffer: PNG, mime_type: 'image/png', file_name: 'preuve.png', caption: 'État initial' }],
  };

  it('génère un PDF qui embarque une annexe de photos', async () => {
    const buffer = await buildEvidenceRecordPdf(report);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('génère un document Word qui embarque les photos', async () => {
    const buffer = await buildEvidenceRecordWord(report);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  });
});
