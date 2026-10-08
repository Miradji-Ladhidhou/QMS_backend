import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { buildCapaPdf } from './capaPdf.js';
import { buildAuditPdf } from './auditPdf.js';
import { buildAuditWord } from './auditWord.js';
import { buildComplaintPdf } from './complaintPdf.js';
import { buildRiskPdf } from './riskPdf.js';
import { buildRiskWord } from './riskWord.js';
import { buildSupplierPdf } from './supplierPdf.js';
import { buildSupplierWord } from './supplierWord.js';
import { buildPdcaPdf } from './pdcaPdf.js';
import { buildQqoqccpPdf } from './qqoqccpPdf.js';
import { buildHaccpAuditPdf } from './haccpAuditPdf.js';
import { buildHaccpAuditWord } from './haccpAuditWord.js';
import { buildEvidenceRecordPdf, buildEvidenceRecordWord } from './evidenceRecordReport.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const evidence = [{ buffer: PNG, mime_type: 'image/png', file_name: 'preuve.png', caption: 'Photo choisie' }];
const record = { id: 'record', title: 'Document de test', status: 'open', created_at: '2026-10-08', category: 'Test' };
const identity = { tenantName: 'Entreprise de test' };
const audit = { ...identity, audit: record, findings: [], checklistItems: [], linkedProcedures: [] };
const risk = { ...identity, risk: { ...record, type: 'risk', likelihood: 2, impact: 2 }, assessments: [], links: [], threshold: 12 };
const supplier = { ...identity, supplier: { name: 'Fournisseur de test', criticality: 'low', status: 'active' }, evaluations: [], documents: [], policy: { frequency_months: 12, thresholds: { watch: 3, replace: 2 }, weights: { quality: 25, delivery: 25, price: 25, responsiveness: 25 } } };
const generic = { ...identity, title: 'Fiche de test', facts: [], sections: [] };
const plan = { ...record, status: 'draft', steps: [] };
const haccp = { ...identity, plans: [plan], monitoringSummaryByCcpId: new Map() };

it.each([
  ['CAPA', (photos) => buildCapaPdf({ ...identity, capa: { ...record, priority: 'medium', category: { name: 'Test' } }, evidence: photos })],
  ['audits', (photos) => buildAuditPdf({ ...audit, evidence: photos })],
  ['reclamations', (photos) => buildComplaintPdf({ ...identity, complaint: record, evidence: photos })],
  ['accidents', (photos) => buildEvidenceRecordPdf({ ...generic, evidence: photos })],
  ['sorties non conformes', (photos) => buildEvidenceRecordPdf({ ...generic, evidence: photos })],
  ['risques', (photos) => buildRiskPdf({ ...risk, evidence: photos })],
  ['fournisseurs et evaluations', (photos) => buildSupplierPdf({ ...supplier, evidence: photos })],
  ['PDCA', (photos) => buildPdcaPdf({ ...identity, pdca: { ...record, status: 'plan', category: { name: 'Test' } }, evidence: photos })],
  ['QQOQCCP', (photos) => buildQqoqccpPdf({ ...identity, analysis: record, evidence: photos })],
  ['HACCP', (photos) => buildHaccpAuditPdf({ ...haccp, evidenceByPlanId: { record: photos } })],
])('generates %s PDFs with photos and without photos', async (name, build) => {
  const withPhotos = await build(evidence);
  const withoutPhotos = await build([]);
  expect(withPhotos.subarray(0, 4).toString()).toBe('%PDF');
  expect(withPhotos.toString('latin1')).toContain('/Subtype /Image');
  expect(withoutPhotos.toString('latin1')).not.toContain('/Subtype /Image');
});

it.each([
  ['CAPA, accidents, sorties non conformes, reclamations, PDCA et QQOQCCP', (photos) => buildEvidenceRecordWord({ ...generic, evidence: photos })],
  ['audits', (photos) => buildAuditWord({ ...audit, evidence: photos })],
  ['risques', (photos) => buildRiskWord({ ...risk, evidence: photos })],
  ['fournisseurs et evaluations', (photos) => buildSupplierWord({ ...supplier, evidence: photos })],
  ['HACCP', (photos) => buildHaccpAuditWord({ ...haccp, evidenceByPlanId: { record: photos } })],
])('generates %s Word documents containing only included photos', async (name, build) => {
  const withPhotos = await JSZip.loadAsync(await build(evidence));
  const withoutPhotos = await JSZip.loadAsync(await build([]));
  expect(Object.keys(withPhotos.files).filter((path) => /^word\/media\/.+/.test(path))).toHaveLength(1);
  expect(Object.keys(withoutPhotos.files).filter((path) => /^word\/media\/.+/.test(path))).toHaveLength(0);
  const xml = await withPhotos.file('word/document.xml').async('string');
  expect(xml).toContain('Photo choisie');
});

it('keeps ten photos and complete long captions within non-overlapping PDF rows', async () => {
  const calls = [];
  const captions = [];
  const originalImage = PDFDocument.prototype.image;
  const originalText = PDFDocument.prototype.text;
  const imageSpy = vi.spyOn(PDFDocument.prototype, 'image').mockImplementation(function (buffer, x, y, options) {
    if (buffer === PNG) calls.push({ page: this.page, x, y, width: options.fit[0], height: options.fit[1] });
    return originalImage.call(this, buffer, x, y, options);
  });
  const textSpy = vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (text, ...args) {
    if (/^\d+\. Légende/.test(text)) captions.push(text);
    return originalText.call(this, text, ...args);
  });
  try {
    const photos = Array.from({ length: 10 }, (_, index) => ({
      ...evidence[0],
      caption: `Légende ${index + 1} ${'description complète '.repeat(13)}`,
    }));
    await buildEvidenceRecordPdf({ ...generic, evidence: photos });
    expect(calls).toHaveLength(10);
    expect(captions).toEqual(photos.map((photo, index) => `${index + 1}. ${photo.caption}`));
    for (let index = 0; index < calls.length; index += 2) {
      const left = calls[index];
      const right = calls[index + 1];
      expect(left.page).toBe(right.page);
      expect(left.y).toBe(right.y);
      expect(left.x + left.width).toBeLessThan(right.x);
      expect(left.y + left.height).toBeLessThan(left.page.height - left.page.margins.bottom);
      if (index > 0 && left.page === calls[index - 2].page) {
        expect(left.y).toBeGreaterThan(calls[index - 2].y + calls[index - 2].height + 18);
      }
    }
  } finally {
    imageSpy.mockRestore();
    textSpy.mockRestore();
  }
});
