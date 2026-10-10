import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import { effectiveSharePermissions } from '../services/sharePermissions.js';
import { protectedFileUrl, decodeFileTicket, authorizedFile } from '../services/sharedFiles.js';
import { sendEmail } from '../services/email.js';
import { SHARE_ROUTE_TYPES } from '../middleware/sharePermissions.js';

vi.mock('../services/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 'test-mail' })) }));
const tenants = [];
const files = [];
afterEach(async () => {
  for (const path of files.splice(0)) {
    const { error } = await admin.storage.from('qms-documents').remove([path]);
    if (error) throw error;
  }
  await Promise.all(tenants.splice(0).map((tenant) => tenant.cleanup()));
  vi.mocked(sendEmail).mockClear();
});
async function fixture() {
  const tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
  tenants.push(tenant);
  return { ...tenant, adminId: tenant.admin.id, adminToken: tenant.admin.token };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function createCapa(tenant, token = tenant.adminToken) {
  const response = await request(app).post('/api/capas').set(auth(token)).send({ title: 'CAPA de test' }).expect(201);
  return response.body;
}
function share(tenant, items, rights = {}) {
  return request(app).post('/api/shares/bundles').set(auth(tenant.adminToken)).send({
    title: 'Dossier partagé', recipient_type: 'user', subject_id: tenant.users[0].id,
    can_edit: false, can_export: false, items, ...rights,
  });
}

describe('Partages centralisés et droits restrictifs', () => {
  it('prévisualise le module masqué et les droits effectifs sans modifier les réglages', async () => {
    const tenant = await fixture();
    const { data: service, error } = await admin.from('services').insert({ tenant_id: tenant.tenantId, name: 'Service partagé' }).select().single();
    expect(error).toBeNull();
    const items = [{ resource_type: 'service', resource_id: service.id }];
    await share(tenant, items, { recipient_type: 'role', subject_id: 'member', can_edit: false, can_export: false }).expect(201);
    const body = { recipient_type: 'user', subject_id: tenant.users[0].id, items, can_edit: true, can_export: true };
    const preview = await request(app).post('/api/shares/bundles/preview').set(auth(tenant.adminToken)).send(body).expect(200);
    expect(preview.body.recipients[0].items[0]).toMatchObject({
      module_visible: false, module_enabled: true, limited_by_other_share: true,
      proposed: { can_edit: false, can_export: false },
    });
    const { count } = await admin.from('record_shares').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.tenantId);
    expect(count).toBe(1);
    await request(app).post('/api/shares/bundles/preview').set(auth(tenant.users[0].token)).send(body).expect(403);
    const foreign = await fixture();
    await request(app).post('/api/shares/bundles/preview').set(auth(tenant.adminToken)).send({ ...body, subject_id: foreign.users[0].id }).expect(400);
    await request(app).post('/api/shares/bundles/preview').set(auth(tenant.adminToken)).send({ ...body, items: [{ resource_type: 'service', resource_id: randomUUID() }] }).expect(404);
    const rolePreview = await request(app).post('/api/shares/bundles/preview').set(auth(tenant.adminToken)).send({
      ...body, recipient_type: 'role', subject_id: 'member', can_edit: false, can_export: false,
    }).expect(200);
    expect(rolePreview.body.recipients[0].items[0].duplicate).toBe(true);
  });
  it('préserve les anciens droits et applique le partage explicite le plus restrictif', () => {
    expect(effectiveSharePermissions([{ can_edit: null, can_export: null }]))
      .toMatchObject({ restricted: false, can_edit: null, can_export: true });
    expect(effectiveSharePermissions([
      { can_edit: null, can_export: null }, { can_edit: true, can_export: true },
      { can_edit: false, can_export: false },
    ])).toMatchObject({ restricted: true, can_edit: false, can_export: false });
  });

  it('crée atomiquement un lot interne mixte sans email et expose les fiches reçues', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const { data: document, error } = await admin.from('documents').insert({
      tenant_id: tenant.tenantId, title: 'Document choisi', number: 'DOC-TEST', created_by: tenant.adminId,
    }).select().single();
    expect(error).toBeNull();
    const items = [{ resource_type: 'capa', resource_id: capa.id }, { resource_type: 'document', resource_id: document.id }];
    vi.mocked(sendEmail).mockClear();
    const result = await share(tenant, items).expect(201);
    expect(result.body.item_count).toBe(2);
    expect(sendEmail).not.toHaveBeenCalled();
    const received = await request(app).get('/api/shares/received').set(auth(tenant.users[0].token)).expect(200);
    expect(received.body.map((item) => item.resource_type).sort()).toEqual(['capa', 'document']);
    await request(app).get(`/api/shares/received/capa/${capa.id}`).set(auth(tenant.users[0].token)).expect(200);
    await request(app).get(`/api/shares/received/capa/${capa.id}/export`).set(auth(tenant.users[0].token)).expect(403);
    await request(app).post('/api/shares/check-export').set(auth(tenant.users[0].token)).send({ path: `/capas/${capa.id}` }).expect(403);
    await request(app).post('/api/shares/check-export').set(auth(tenant.users[0].token)).send({ path: '/suppliers' }).expect(204);
    await share(tenant, [items[0], { resource_type: 'document', resource_id: randomUUID() }], { can_edit: true }).expect(404);
    const { data: unchanged } = await admin.from('record_shares').select('can_edit').eq('tenant_id', tenant.tenantId);
    expect(unchanged.every((row) => row.can_edit === false)).toBe(true);
  });

  it('bloque les écritures et exports pour tous les types et garde le bypass administrateur', async () => {
    const tenant = await fixture();
    const member = tenant.users[0];
    const ids = new Map(Object.values(SHARE_ROUTE_TYPES).map((type) => [type, randomUUID()]));
    const { error } = await admin.from('record_shares').insert([...ids].map(([resource_type, resource_id]) => ({
      tenant_id: tenant.tenantId, resource_type, resource_id, subject_type: 'user',
      subject_id: member.id, created_by: tenant.adminId, can_edit: false, can_export: false,
    })));
    expect(error).toBeNull();
    for (const [module, type] of Object.entries(SHARE_ROUTE_TYPES)) {
      const path = `/api/${module}/${type === 'haccp_plan' ? 'plans/' : ''}${ids.get(type)}`;
      const denied = await request(app).patch(path).set(auth(member.token)).send({ title: 'Interdit' }).expect(403);
      expect(denied.body.code).toBe('SHARE_READ_ONLY');
      const download = await request(app).get(`${path}/pdf`).set(auth(member.token)).expect(403);
      expect(download.body.code).toBe('SHARE_EXPORT_DENIED');
    }
    const capa = await createCapa(tenant, member.token);
    await share(tenant, [{ resource_type: 'capa', resource_id: capa.id }]).expect(201);
    await request(app).patch(`/api/capas/${capa.id}`).set(auth(member.token)).send({ title: 'Interdit malgré assignation' }).expect(403);
    await request(app).patch(`/api/capas/${capa.id}`).set(auth(tenant.adminToken)).send({ title: 'Admin autorisé' }).expect(200);
  });

  it('accorde une édition explicite sans accorder la suppression et retire la restriction après révocation', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const items = [{ resource_type: 'capa', resource_id: capa.id }];
    await share(tenant, items, { can_edit: true, can_export: true }).expect(201);
    const memberAuth = auth(tenant.users[0].token);
    await request(app).patch(`/api/capas/${capa.id}`).set(memberAuth).send({ title: 'Modification autorisée' }).expect(200);
    await request(app).delete(`/api/capas/${capa.id}`).set(memberAuth).expect(403);
    await request(app).get(`/api/shares/received/capa/${capa.id}/export`).set(memberAuth).expect(200);
    await request(app).patch(`/api/capas/${capa.id}`).set(memberAuth).send({ effectiveness_verified: true, effectiveness_notes: 'Verdict' }).expect(403);
    await request(app).patch(`/api/capas/${capa.id}`).set(memberAuth).send({ status: 'closed' }).expect(403);
    await share(tenant, items, { can_edit: false, can_export: true }).expect(201);
    await request(app).get(`/api/capas/${capa.id}/pdf`).set(memberAuth).expect(200);
    await request(app).patch(`/api/capas/${capa.id}`).set(memberAuth).send({ title: 'Interdit' }).expect(403);
    const { data: row } = await admin.from('record_shares').select('id').eq('tenant_id', tenant.tenantId).single();
    await request(app).delete(`/api/shares/${row.id}`).set(auth(tenant.adminToken)).expect(204);
    await request(app).get(`/api/shares/received/capa/${capa.id}`).set(memberAuth).expect(404);
  });

  it('respecte le cloisonnement par propriétaire dans la sélection du gestionnaire', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const managerAuth = auth(tenant.users[1].token);
    const list = await request(app).get('/api/shares/bundles/resources?resource_type=capa').set(managerAuth).expect(200);
    expect(list.body.items.some((row) => row.resource_id === capa.id)).toBe(false);
    await request(app).post('/api/shares/bundles').set(managerAuth).send({
      title: 'Tentative', recipient_type: 'user', subject_id: tenant.users[0].id,
      items: [{ resource_type: 'capa', resource_id: capa.id }],
    }).expect(404);
  });

  it('protège les objets privés et revérifie les droits au téléchargement', async () => {
    const tenant = await fixture();
    const path = `${tenant.tenantId}/test-${randomUUID()}.txt`;
    const { error: uploadError } = await admin.storage.from('qms-documents').upload(path, Buffer.from('fichier protege'));
    expect(uploadError).toBeNull();
    files.push(path);
    const { data: document, error } = await admin.from('documents').insert({
      tenant_id: tenant.tenantId, title: 'Fichier privé', number: 'FILE-TEST', created_by: tenant.adminId,
      file_path: path, file_name: 'fichier.txt', storage_provider: 'supabase',
    }).select().single();
    expect(error).toBeNull();
    const publicUrl = admin.storage.from('qms-documents').getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);
    await share(tenant, [{ resource_type: 'document', resource_id: document.id }], { can_export: true }).expect(201);
    const download = await request(app).get(`/api/documents/${document.id}/download`).set(auth(tenant.users[0].token)).expect(200);
    const ticket = decodeFileTicket(download.body.url.split('/').at(-1));
    expect(await authorizedFile(ticket)).toMatchObject({ path });
    await request(app).get(new URL(download.body.url).pathname).expect(200);
    await share(tenant, [{ resource_type: 'document', resource_id: document.id }], { can_export: false }).expect(201);
    expect(await authorizedFile(ticket)).toBeNull();
    await request(app).get(new URL(download.body.url).pathname).expect(403);
    expect(decodeFileTicket(`${download.body.url.split('/').at(-1)}x`)).toBeNull();
    const url = protectedFileUrl({ tenantId: tenant.tenantId, user: { id: tenant.users[0].id }, protocol: 'http', get: () => 'localhost' },
      { resourceType: 'document', resourceId: document.id });
    expect(decodeFileTicket(url.split('/').at(-1)).userId).toBe(tenant.users[0].id);
    await request(app).get('/api/documents/drive-file?ticket=old').expect(410);
  });

  it('bloque le contournement par écritures PostgREST directes', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: auth(tenant.users[0].token) },
    });
    const direct = await client.from('capas').update({ title: 'Contournement' }).eq('id', capa.id).select();
    expect(direct.data || []).toHaveLength(0);
    const attempt = await client.from('record_shares').insert({
      tenant_id: tenant.tenantId, resource_type: 'capa', resource_id: capa.id,
      subject_type: 'user', subject_id: tenant.users[0].id, created_by: tenant.users[0].id, can_edit: true,
    });
    expect(attempt.error).not.toBeNull();
    const { data } = await admin.from('capas').select('title').eq('id', capa.id).single();
    expect(data.title).toBe('CAPA de test');
  });

  it('permet de modifier des référentiels partagés sans ouvrir leur menu ou leurs suppressions', async () => {
    const tenant = await fixture();
    for (const [type, table, field, module] of [
      ['employee', 'employees', 'full_name', 'employees'],
      ['service', 'services', 'name', 'services'],
    ]) {
      const { data: record, error } = await admin.from(table).insert({ tenant_id: tenant.tenantId, [field]: 'Avant' }).select().single();
      expect(error).toBeNull();
      await share(tenant, [{ resource_type: type, resource_id: record.id }], { can_edit: true }).expect(201);
      const received = await request(app).get(`/api/shares/received/${type}/${record.id}`).set(auth(tenant.users[0].token)).expect(200);
      expect(received.body.resource[field]).toBe('Avant');
      await request(app).patch(`/api/${module}/${record.id}`).set(auth(tenant.users[0].token)).send({ [field]: 'Après' }).expect(200);
      await request(app).delete(`/api/${module}/${record.id}`).set(auth(tenant.users[0].token)).expect(403);
    }
  });

  it('applique la restriction d’un rôle même si un partage utilisateur autorise davantage', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const items = [{ resource_type: 'capa', resource_id: capa.id }];
    await share(tenant, items, { can_edit: true, can_export: true }).expect(201);
    await share(tenant, items, { recipient_type: 'role', subject_id: 'member' }).expect(201);
    await request(app).patch(`/api/capas/${capa.id}`).set(auth(tenant.users[0].token)).send({ title: 'Refusé' }).expect(403);
    await request(app).get(`/api/capas/${capa.id}/pdf`).set(auth(tenant.users[0].token)).expect(403);
    const otherCapa = await createCapa(tenant, tenant.users[0].token);
    await request(app).get(`/api/capas/${otherCapa.id}/pdf`).set(auth(tenant.users[0].token)).expect(200);
    const other = await fixture();
    await share(tenant, items, { subject_id: other.users[0].id }).expect(400);
  });

  it('autorise et révoque l’export invité sans accorder de modification', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const items = [{ resource_type: 'capa', resource_id: capa.id }];
    const created = await share(tenant, items, {
      recipient_type: 'guest', email: 'guest@example.com', expires_in_days: 7, can_export: true,
    }).expect(201);
    const token = sendEmail.mock.calls.at(-1)[2].match(/\/guest\/([A-Za-z0-9_-]+)/)[1];
    const path = `/api/public/guest-shares/${token}`;
    await request(app).post(`${path}/send-code`).send({ email: 'guest@example.com' }).expect(200);
    const code = sendEmail.mock.calls.at(-1)[2].match(/>(\d{8})<\/p>/)[1];
    const verified = await request(app).post(`${path}/verify`).send({ code }).expect(200);
    const guestAuth = auth(verified.body.access_token);
    const item = verified.body.items[0];
    expect(verified.body.can_export).toBe(true);
    const result = await request(app).get(`${path}/export?item_id=${item.id}`).set(guestAuth).expect(200);
    expect(result.body.resource.title).toBe(capa.title);
    await request(app).get(`${path}/export?item_id=${randomUUID()}`).set(guestAuth).expect(404);
    await request(app).get(`${path}/export?item_id=${item.id}`).expect(401);
    await request(app).patch(`/api/shares/bundles/${created.body.id}`).set(auth(tenant.adminToken)).send({ can_export: false }).expect(200);
    await request(app).get(`${path}/export?item_id=${item.id}`).set(guestAuth).expect(403);
    await share(tenant, items, { recipient_type: 'guest', email: 'guest@example.com', expires_in_days: 7, can_edit: true }).expect(400);
  });

  it('empêche un gestionnaire de retirer lui-même les restrictions administrateur', async () => {
    const tenant = await fixture();
    const capa = await createCapa(tenant);
    const items = [{ resource_type: 'capa', resource_id: capa.id }];
    await share(tenant, items, { subject_id: tenant.users[1].id }).expect(201);
    const { data: row } = await admin.from('record_shares').select('id').eq('tenant_id', tenant.tenantId).single();
    const managerAuth = auth(tenant.users[1].token);
    await request(app).delete(`/api/shares/${row.id}`).set(managerAuth).expect(403);
    await request(app).patch(`/api/shares/internal/${row.id}`).set(managerAuth).send({ can_edit: true, can_export: true }).expect(403);
    await request(app).post('/api/shares/bundles').set(managerAuth).send({
      title: 'Contournement', items, recipient_type: 'user', subject_id: tenant.users[1].id, can_edit: true,
    }).expect(403);
  });
});
