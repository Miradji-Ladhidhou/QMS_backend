import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getDriveFileStream: vi.fn(),
  refreshAccessTokenIfNeeded: vi.fn(),
  evidenceSelect: vi.fn(),
  evidenceIn: vi.fn(),
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

afterEach(() => {
  vi.clearAllMocks();
});

it('loads Drive file IDs for exports without exposing them in the regular evidence listing', async () => {
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
      eq: vi.fn(() => query),
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
