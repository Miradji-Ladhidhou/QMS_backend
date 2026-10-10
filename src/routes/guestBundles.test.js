import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { sendEmail } from '../services/email.js';
import { generateGuestToken, hashGuestToken } from '../services/guestSharing.js';
import { SHAREABLE_RESOURCES } from '../services/shareableResources.js';

vi.mock('../services/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 'mock-mail' })) }));

const tenants = [];
beforeEach(() => vi.mocked(sendEmail).mockClear());
afterEach(async () => {
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue({ id: 'mock-mail' });
  await Promise.all(tenants.splice(0).map((tenant) => tenant.cleanup()));
});

async function fixture(options) {
  const tenant = await createTenant(options);
  tenants.push(tenant);
  return tenant;
}

async function capa(tenant, extra = {}) {
  const result = await request(app).post('/api/capas')
    .set('Authorization', `Bearer ${tenant.admin.token}`).send({ title: 'CAPA choisie', ...extra }).expect(201);
  return result.body;
}

const selection = (type, id) => ({ resource_type: type, resource_id: id });
const invitation = (items) => ({ title: 'Lot audit', email: 'guest@example.com', expires_in_days: 7, items });
const publicPath = (token) => `/api/public/guest-shares/${token}`;
const linkToken = () => sendEmail.mock.calls.at(-1)[2].match(/\/guest\/([A-Za-z0-9_-]+)/)[1];

async function unlock(token) {
  await request(app).post(`${publicPath(token)}/send-code`).send({ email: 'guest@example.com' }).expect(200);
  const code = sendEmail.mock.calls.at(-1)[2].match(/>(\d{8})<\/p>/)[1];
  const verified = await request(app).post(`${publicPath(token)}/verify`).send({ code }).expect(200);
  return { verified, code, access: verified.body.access_token };
}

describe('Invitations groupées avec un lot figé', () => {
  it('propose et charge tous les types d’enregistrements existants', async () => {
    const tenant = await fixture();
    const auth = `Bearer ${tenant.admin.token}`;
    const catalog = await request(app).get('/api/shares/bundles/catalog').set('Authorization', auth).expect(200);
    expect(catalog.body.map((item) => item.resource_type).sort()).toEqual(Object.keys(SHAREABLE_RESOURCES).sort());
    for (const item of catalog.body) {
      const records = await request(app).get(`/api/shares/bundles/resources?resource_type=${item.resource_type}`)
        .set('Authorization', auth).expect(200);
      expect(records.body.items).toBeInstanceOf(Array);
    }
  });

  it('envoie un seul lien, vérifie un code, consulte un lot mixte et révoque tout le lot', async () => {
    const tenant = await fixture();
    const first = await capa(tenant);
    const { data: service, error } = await admin.from('services')
      .insert({ tenant_id: tenant.tenantId, name: 'Qualité' }).select().single();
    expect(error).toBeNull();
    sendEmail.mockClear();
    const created = await request(app).post('/api/shares/bundles')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(invitation([selection('capa', first.id), selection('service', service.id), selection('capa', first.id)]))
      .expect(201);
    expect(created.body.item_count).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const token = linkToken();
    const metadata = await request(app).get(publicPath(token)).expect(200);
    expect(metadata.body.items).toBeUndefined();
    await request(app).get(`${publicPath(token)}/data`).expect(401);
    const { verified, code, access } = await unlock(token);
    expect(verified.body.items).toHaveLength(2);
    expect(verified.body.items.map((item) => item.resource_type).sort()).toEqual(['capa', 'service']);
    await request(app).post(`${publicPath(token)}/verify`).send({ code }).expect(410);
    const later = await capa(tenant, { title: 'Créée après invitation' });
    const refreshed = await request(app).get(`${publicPath(token)}/data`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(refreshed.body.items).toHaveLength(2);
    expect(refreshed.body.items.some((item) => item.resource_id === later.id)).toBe(false);
    const item = verified.body.items.find((row) => row.resource_type === 'capa');
    const read = await request(app).get(`${publicPath(token)}/items/${item.id}`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(read.body.resource.title).toBe('CAPA choisie');
    expect(read.body.resource.tenant_id).toBeUndefined();
    await request(app).get(`${publicPath(token)}/items/${item.id}`).expect(401);
    await request(app).get(`${publicPath(token)}/items/${later.id}`).set('Authorization', `Bearer ${access}`).expect(404);
    const history = await request(app).get('/api/shares/bundles').set('Authorization', `Bearer ${tenant.admin.token}`).expect(200);
    expect(history.body.items[0]).toMatchObject({ id: created.body.id, item_count: 2 });
    await request(app).delete(`/api/shares/guest/${created.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(204);
    await request(app).get(`${publicPath(token)}/data`).set('Authorization', `Bearer ${access}`).expect(410);
    await request(app).get(`${publicPath(token)}/items/${item.id}`).set('Authorization', `Bearer ${access}`).expect(410);
  });

  it('conserve le parcours des invitations individuelles', async () => {
    const tenant = await fixture();
    const record = await capa(tenant);
    await request(app).post('/api/shares/guest').set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: record.id, email: 'guest@example.com' }).expect(201);
    const token = linkToken();
    const { verified, access } = await unlock(token);
    expect(verified.body.resource.title).toBe(record.title);
    expect(verified.body.items).toBeUndefined();
    const data = await request(app).get(`${publicPath(token)}/data`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(data.body.resource.title).toBe(record.title);
  });

  it('rejette une sélection vide, un membre, un autre tenant et une catégorie inaccessible', async () => {
    const tenant = await fixture({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const foreignTenant = await fixture();
    const foreign = await capa(foreignTenant);
    const auth = `Bearer ${tenant.admin.token}`;
    await request(app).post('/api/shares/bundles').set('Authorization', auth).send(invitation([])).expect(400);
    await request(app).post('/api/shares/bundles').set('Authorization', `Bearer ${tenant.users[0].token}`)
      .send(invitation([selection('capa', foreign.id)])).expect(403);
    await request(app).post('/api/shares/bundles').set('Authorization', auth)
      .send(invitation([selection('capa', foreign.id)])).expect(404);
    const category = await request(app).post('/api/module-categories').set('Authorization', auth)
      .send({ resource_type: 'capa', name: 'Restreinte', is_restricted: true }).expect(201);
    const restricted = await capa(tenant, { category_id: category.body.id });
    const managerAuth = `Bearer ${tenant.users[1].token}`;
    const listed = await request(app).get('/api/shares/bundles/resources?resource_type=capa')
      .set('Authorization', managerAuth).expect(200);
    expect(listed.body.items.some((item) => item.resource_id === restricted.id)).toBe(false);
    await request(app).post('/api/shares/bundles').set('Authorization', managerAuth)
      .send(invitation([selection('capa', restricted.id)])).expect(404);
    const catalog = await request(app).get('/api/shares/bundles/catalog').set('Authorization', managerAuth).expect(200);
    expect(catalog.body.some((item) => item.resource_type === 'employee')).toBe(false);
  });

  it('inclut la pagination et respecte les modules désactivés', async () => {
    const tenant = await fixture();
    const { error } = await admin.from('services').insert(Array.from({ length: 101 }, (_, index) => ({
      tenant_id: tenant.tenantId, name: `Service ${index}`,
    })));
    expect(error).toBeNull();
    const auth = `Bearer ${tenant.admin.token}`;
    const first = await request(app).get('/api/shares/bundles/resources?resource_type=service').set('Authorization', auth).expect(200);
    expect(first.body.items).toHaveLength(100);
    expect(first.body.next_offset).toBe(100);
    const second = await request(app).get('/api/shares/bundles/resources?resource_type=service&offset=100').set('Authorization', auth).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.next_offset).toBeNull();
    const all = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((item) => item.resource_id)).size).toBe(101);
    const created = await request(app).post('/api/shares/bundles').set('Authorization', auth).send(invitation(all)).expect(201);
    expect(created.body.item_count).toBe(101);
    const { verified } = await unlock(linkToken());
    expect(verified.body.items).toHaveLength(101);
    const updated = await admin.from('tenants').update({ app_modules: { services: false } }).eq('id', tenant.tenantId);
    expect(updated.error).toBeNull();
    await request(app).get('/api/shares/bundles/resources?resource_type=service').set('Authorization', auth).expect(403);
    await request(app).post('/api/shares/bundles').set('Authorization', auth).send(invitation([all[0]])).expect(403);
  });

  it('ne conserve aucun lot ni élément si l’envoi email échoue', async () => {
    const tenant = await fixture();
    const record = await capa(tenant);
    sendEmail.mockRejectedValueOnce(new Error('Transport email indisponible'));
    await request(app).post('/api/shares/bundles').set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(invitation([selection('capa', record.id)])).expect(500);
    const shares = await admin.from('guest_shares').select('id').eq('tenant_id', tenant.tenantId);
    const items = await admin.from('guest_share_items').select('id').eq('tenant_id', tenant.tenantId);
    expect(shares.error).toBeNull();
    expect(items.error).toBeNull();
    expect(shares.data).toEqual([]);
    expect(items.data).toEqual([]);
  });

  it('signale un élément supprimé et interdit un élément appartenant à un autre lot', async () => {
    const tenant = await fixture();
    const first = await capa(tenant);
    const second = await capa(tenant);
    const auth = `Bearer ${tenant.admin.token}`;
    await request(app).post('/api/shares/bundles').set('Authorization', auth).send(invitation([selection('capa', first.id)])).expect(201);
    const firstToken = linkToken();
    const firstAccess = await unlock(firstToken);
    await request(app).post('/api/shares/bundles').set('Authorization', auth).send(invitation([selection('capa', second.id)])).expect(201);
    const secondAccess = await unlock(linkToken());
    await request(app).get(`${publicPath(firstToken)}/items/${secondAccess.verified.body.items[0].id}`)
      .set('Authorization', `Bearer ${firstAccess.access}`).expect(404);
    await admin.from('capas').delete().eq('id', first.id);
    const deleted = await request(app).get(`${publicPath(firstToken)}/items/${firstAccess.verified.body.items[0].id}`)
      .set('Authorization', `Bearer ${firstAccess.access}`).expect(404);
    expect(deleted.body.error).toContain('supprimé');
  });

  it('crée atomiquement le lot et ses éléments et bloque les lots expirés', async () => {
    const tenant = await fixture();
    const record = await capa(tenant);
    const item = { ...selection('capa', record.id), label: record.title };
    const { error } = await admin.rpc('create_guest_share_bundle', {
      p_tenant_id: tenant.tenantId, p_created_by: tenant.admin.id, p_title: 'Lot invalide',
      p_email: 'guest@example.com', p_token_hash: hashGuestToken(generateGuestToken()),
      p_expires_at: new Date(Date.now() + 86400000).toISOString(), p_items: [item, item],
    });
    expect(error?.code).toBe('23505');
    const absent = await admin.from('guest_shares').select('id').eq('tenant_id', tenant.tenantId);
    expect(absent.error).toBeNull();
    expect(absent.data).toEqual([]);
    const created = await request(app).post('/api/shares/bundles').set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(invitation([item])).expect(201);
    const token = linkToken();
    const { access, verified } = await unlock(token);
    await request(app).patch(`${publicPath(token)}/items/${verified.body.items[0].id}`)
      .set('Authorization', `Bearer ${access}`).send({ title: 'Modification interdite' }).expect(404);
    const expired = await admin.from('guest_shares').update({ expires_at: new Date(Date.now() - 60000).toISOString() })
      .eq('id', created.body.id);
    expect(expired.error).toBeNull();
    await request(app).get(`${publicPath(token)}/data`).set('Authorization', `Bearer ${access}`).expect(410);
    await request(app).get(`${publicPath(token)}/items/${verified.body.items[0].id}`).set('Authorization', `Bearer ${access}`).expect(410);
  });
});
