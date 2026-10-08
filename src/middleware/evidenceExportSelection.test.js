import { expect, it } from 'vitest';
import { parseEvidenceExportSelection } from './evidenceExportSelection.js';

const RECORD = '11111111-1111-4111-8111-111111111111';
const PHOTO = '22222222-2222-4222-8222-222222222222';

it('preserves the default of all photos and distinguishes explicit exclusion', () => {
  expect(parseEvidenceExportSelection({}).legacyIds).toBeUndefined();
  const result = parseEvidenceExportSelection({ evidenceSelections: JSON.stringify({ [`capas:${RECORD}`]: [] }) });
  expect(result.selections.get(`capas:${RECORD}`)).toEqual([]);
  expect(result.selections.get(`audits:${RECORD}`)).toBeUndefined();
});

it('accepts independent selections for suppliers and their evaluations', () => {
  const result = parseEvidenceExportSelection({
    evidenceSelections: JSON.stringify({ [`suppliers:${RECORD}`]: [PHOTO, PHOTO], [`supplier-evaluations:${PHOTO}`]: [] }),
  });
  expect(result.selections.get(`suppliers:${RECORD}`)).toEqual([PHOTO]);
  expect(result.selections.get(`supplier-evaluations:${PHOTO}`)).toEqual([]);
});

it('remains compatible with the previously deployed CAPA selection', () => {
  expect(parseEvidenceExportSelection({ evidenceSelection: 'true', evidenceIds: PHOTO }).legacyIds).toEqual([PHOTO]);
  expect(parseEvidenceExportSelection({ evidenceSelection: 'true' }).legacyIds).toEqual([]);
});

it.each([
  { evidenceSelections: 'not-json' },
  { evidenceSelections: '{}'.repeat(30000) },
  { evidenceSelections: [] },
  { evidenceSelections: 'null' },
  { evidenceSelections: '[]' },
  { evidenceSelections: JSON.stringify({ [`capas:${RECORD}`]: ['not-uuid'] }) },
  { evidenceSelections: JSON.stringify({ [`capas:${RECORD}`]: Array(11).fill(PHOTO) }) },
  { evidenceSelections: JSON.stringify({ 'capas:invalid': [] }) },
  { evidenceSelection: 'false' },
  { evidenceSelection: 'true', evidenceIds: [{}] },
])('rejects malformed selection with an explicit 400 error: %j', (query) => {
  expect(() => parseEvidenceExportSelection(query)).toThrow(expect.objectContaining({ statusCode: 400 }));
});
