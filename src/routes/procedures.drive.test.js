import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { encrypt } from '../services/encryption.js';
import * as googleDrive from '../services/googleDrive.js';

// Seul uploadFile est mocké — refreshAccessTokenIfNeeded reste réel : avec un token_expires_at
// suffisamment loin dans le futur, il se contente de déchiffrer localement (pas d'appel
// réseau), donc une connexion Drive "fake" mais correctement chiffrée avec la vraie
// ENCRYPTION_KEY de l'environnement de test suffit à exercer tout le chemin réel de
// resolveTenantStorageProvider sans jamais parler à l'API Google.
vi.mock('../services/googleDrive.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, uploadFile: vi.fn() };
});

let tenant;

afterEach(async () => {
  vi.clearAllMocks();
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function connectDrive(tenantId, { rootFolderId = 'fake-root-folder-id' } = {}) {
  await admin.from('tenant_storage_settings').insert({ tenant_id: tenantId, storage_provider: 'google_drive' });
  await admin.from('google_drive_connections').insert({
    tenant_id: tenantId,
    google_email: 'test@example.com',
    access_token: encrypt('fake-access-token'),
    refresh_token: encrypt('fake-refresh-token'),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    root_folder_id: rootFolderId,
  });
}

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/procedures/:id/versions/:versionId/attachment — upload vers Google Drive (mocké)', () => {
  it('cible bien le dossier racine et le token du TENANT connecté, persiste le driveFileId renvoyé, récupérable ensuite', async () => {
    tenant = await createTenant();
    await connectDrive(tenant.tenantId, { rootFolderId: 'root-folder-du-tenant' });
    googleDrive.uploadFile.mockResolvedValueOnce('mocked-drive-file-id-123');

    const procedure = await createProcedure(tenant.admin.token, 'PROC-D01');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(version.status).toBe(201);

    const upload = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', Buffer.from('%PDF-1.4 contenu factice'), 'procedure-officielle.pdf');

    expect(upload.status).toBe(201);
    expect(upload.body.attachment_drive_file_id).toBe('mocked-drive-file-id-123');
    expect(upload.body.attachment_file_name).toBe('procedure-officielle.pdf');

    expect(googleDrive.uploadFile).toHaveBeenCalledTimes(1);
    const [accessToken, options] = googleDrive.uploadFile.mock.calls[0];
    expect(accessToken).toBe('fake-access-token');
    expect(options.name).toBe('procedure-officielle.pdf');
    expect(options.parentFolderId).toBe('root-folder-du-tenant');

    const detail = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.versions.find((v) => v.id === version.body.id).attachment_drive_file_id).toBe(
      'mocked-drive-file-id-123'
    );

    const link = await request(app)
      .get(`/api/procedures/${procedure.id}/versions/${version.body.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(link.status).toBe(200);
    expect(link.body.url).toContain('/api/documents/drive-file?ticket=');
  });

  it('un échec Google Drive renvoie une erreur explicite, ne persiste rien', async () => {
    tenant = await createTenant();
    await connectDrive(tenant.tenantId);
    googleDrive.uploadFile.mockRejectedValueOnce(new Error('quota exceeded'));

    const procedure = await createProcedure(tenant.admin.token, 'PROC-D02');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    const upload = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', Buffer.from('contenu'), 'fichier.pdf');

    expect(upload.status).toBe(500);

    const detail = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.versions.find((v) => v.id === version.body.id).attachment_drive_file_id).toBeNull();
  });
});
