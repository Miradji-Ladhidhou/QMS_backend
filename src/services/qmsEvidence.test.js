import { beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getDriveFileStream: vi.fn(),
  refreshAccessTokenIfNeeded: vi.fn(),
  evidenceSelect: vi.fn(),
  evidenceIn: vi.fn(),
  evidenceEq: vi.fn(),
}));

vi.mock('./supabase.js', () => ({
  supabase: { from: mocks.from },
}));

vi.mock('./googleDrive.js', () => ({
  deleteDriveFile: vi.fn(),
  getDriveFileStream: mocks.getDriveFileStream,
  getOrCreateCategoryFolder: vi.fn(),
  refreshAccessTokenIfNeeded: mocks.refreshAccessTokenIfNeeded,
  uploadFile: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  const evidence = [{
    id: 'evidence-id',
    drive_file_id: 'google-drive-file-id',
    file_name: 'preuve.jpg',
    mime_type: 'image/jpeg',
  }, {
    id: 'other-evidence-id',
    drive_file_id: 'other-google-drive-file-id',
    file_name: 'autre-preuve.jpg',
    mime_type: 'image/jpeg',
  }];
  const connection = { access_token: 'encrypted-token' };

  mocks.from.mockImplementation((table) => {
    let filteredIds;
    const query = {
      select: vi.fn((fields) => {
        if (table === 'qms_evidence_attachments') mocks.evidenceSelect(fields);
        return query;
      }),
      eq: vi.fn((column, value) => {
        if (table === 'qms_evidence_attachments') mocks.evidenceEq(column, value);
        return query;
      }),
      in: vi.fn((column, ids) => {
        mocks.evidenceIn(column, ids);
        filteredIds = ids;
        return query;
      }),
      order: vi.fn(async () => ({ data: filteredIds ? evidence.filter((item) => filteredIds.includes(item.id)) : evidence, error: null })),
      maybeSingle: vi.fn(async () => ({ data: connection, error: null })),
    };
    return query;
  });
  mocks.refreshAccessTokenIfNeeded.mockResolvedValue('access-token');
  mocks.getDriveFileStream.mockImplementation(async () => Readable.from([Buffer.from('photo')]));
});

it('loads Drive file IDs for exports without exposing them in the regular evidence listing', async () => {
  const { loadEvidenceForExport, listEvidence } = await import('./qmsEvidence.js');
  const exported = await loadEvidenceForExport({ tenantId: 'tenant-id', moduleKey: 'capas', recordId: 'capa-id' });

  expect(mocks.evidenceSelect).toHaveBeenCalledWith(expect.stringContaining('drive_file_id'));
  expect(mocks.getDriveFileStream).toHaveBeenCalledWith('access-token', 'google-drive-file-id');
  expect(exported[0].buffer.toString()).toBe('photo');

  mocks.getDriveFileStream.mockClear();
  const selected = await loadEvidenceForExport({
    tenantId: 'tenant-id',
    moduleKey: 'capas',
    recordId: 'capa-id',
    evidenceIds: ['evidence-id'],
  });
  expect(mocks.evidenceIn).toHaveBeenCalledWith('id', ['evidence-id']);
  expect(mocks.getDriveFileStream).toHaveBeenCalledTimes(1);
  expect(selected).toHaveLength(1);

  mocks.from.mockClear();
  mocks.evidenceSelect.mockClear();
  await listEvidence({ tenantId: 'tenant-id', moduleKey: 'capas', recordId: 'capa-id' });
  expect(mocks.evidenceSelect).toHaveBeenCalledWith(expect.not.stringContaining('drive_file_id'));
});

it.each(['capas', 'audits', 'complaints', 'accidents', 'nonconforming-outputs', 'haccp', 'risks', 'suppliers', 'supplier-evaluations', 'pdca', 'qqoqccp'])(
  'downloads only the selected photos for %s within the tenant and record',
  async (moduleKey) => {
    const { loadEvidenceForRequest } = await import('./qmsEvidence.js');
    const req = {
      tenantId: 'tenant-id',
      evidenceExportSelection: { selections: new Map([[`${moduleKey}:record-id`, ['evidence-id']]]) },
    };
    const result = await loadEvidenceForRequest(req, moduleKey, 'record-id');
    expect(result.map((item) => item.id)).toEqual(['evidence-id']);
    expect(mocks.evidenceEq.mock.calls).toEqual([
      ['tenant_id', 'tenant-id'], ['module_key', moduleKey], ['record_id', 'record-id'],
    ]);
    expect(mocks.getDriveFileStream).toHaveBeenCalledTimes(1);
    expect(mocks.getDriveFileStream).toHaveBeenCalledWith('access-token', 'google-drive-file-id');
    expect(result[0].buffer.toString()).toBe('photo');
  }
);

it('exports no photos without contacting the database or Google Drive when all are excluded', async () => {
  const { loadEvidenceForRequest } = await import('./qmsEvidence.js');
  const req = {
    tenantId: 'tenant-id',
    evidenceExportSelection: { selections: new Map([['suppliers:record-id', []]]) },
  };
  expect(await loadEvidenceForRequest(req, 'suppliers', 'record-id')).toEqual([]);
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.getDriveFileStream).not.toHaveBeenCalled();
});

it('does not borrow another record selection and does not download unknown IDs', async () => {
  const { loadEvidenceForRequest } = await import('./qmsEvidence.js');
  const req = {
    tenantId: 'tenant-id',
    evidenceExportSelection: { selections: new Map([['supplier-evaluations:other-record', []]]) },
  };
  expect(await loadEvidenceForRequest(req, 'suppliers', 'record-id')).toHaveLength(2);
  expect(mocks.evidenceIn).not.toHaveBeenCalled();
  mocks.getDriveFileStream.mockClear();
  req.evidenceExportSelection.selections.set('suppliers:record-id', ['unknown-id']);
  expect(await loadEvidenceForRequest(req, 'suppliers', 'record-id')).toEqual([]);
  expect(mocks.getDriveFileStream).not.toHaveBeenCalled();
});
