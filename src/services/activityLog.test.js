import { describe, it, expect } from 'vitest';
import { admin } from '../test-utils/tenant.js';
import { logActivity, logCreate, logUpdate, logDelete, logTransition, logBulk } from './activityLog.js';

// activity_log est immuable (trigger, voir schema.sql) : impossible de nettoyer par DELETE
// comme le reste de la suite — chaque test utilise un entity_type/action unique (préfixé
// "test-activity-log-...") pour ne jamais interférer avec un autre test, et les lignes
// restent en base indéfiniment (comme n'importe quelle vraie ligne d'audit).
function uniqueEntity(base) {
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function latestRow(entityType) {
  const { data } = await admin
    .from('activity_log')
    .select('*')
    .eq('entity_type', entityType)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

const FAKE_REQ = { ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } };
const FAKE_USER_REQ = { ...FAKE_REQ, tenantId: 'a1a1a1a1-0000-0000-0000-000000000001', user: { id: 'b2b2b2b2-0000-0000-0000-000000000002', email: 'alice@example.com' } };

describe('logActivity', () => {
  it('insère une ligne avec tous les champs, ip/user-agent depuis req', async () => {
    const entity = uniqueEntity('test-activity-log-core');
    await logActivity({
      tenantId: '11111111-1111-1111-1111-111111111111',
      actorId: '22222222-2222-2222-2222-222222222222',
      actorEmail: 'alice@example.com',
      action: 'TEST_ACTION',
      entityType: entity,
      entityId: '33333333-3333-3333-3333-333333333333',
      metadata: { foo: 'bar' },
      req: FAKE_REQ,
    });

    const row = await latestRow(entity);
    expect(row.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(row.actor_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(row.actor_email).toBe('alice@example.com');
    expect(row.action).toBe('TEST_ACTION');
    expect(row.entity_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(row.metadata).toEqual({ foo: 'bar' });
    expect(row.ip_address).toBe('203.0.113.7');
    expect(row.user_agent).toBe('vitest');
  });

  it('tenantId/actorId/entityId absents -> null, jamais une chaîne vide ou une exception', async () => {
    const entity = uniqueEntity('test-activity-log-nulls');
    await logActivity({ action: 'TEST_ACTION', entityType: entity });

    const row = await latestRow(entity);
    expect(row.tenant_id).toBeNull();
    expect(row.actor_id).toBeNull();
    expect(row.actor_email).toBeNull();
    expect(row.entity_id).toBeNull();
    expect(row.metadata).toBeNull();
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
  });

  it('metadata vide ({}) -> stocké comme null, pas comme un objet vide', async () => {
    const entity = uniqueEntity('test-activity-log-empty-metadata');
    await logActivity({ action: 'TEST_ACTION', entityType: entity, metadata: {} });
    const row = await latestRow(entity);
    expect(row.metadata).toBeNull();
  });
});

describe('logCreate / logUpdate / logDelete / logTransition / logBulk', () => {
  it('logCreate dérive ${ENTITY}_CREATED et inclut label dans metadata', async () => {
    const entity = uniqueEntity('test-activity-log-capa');
    await logCreate({ req: FAKE_USER_REQ, entity, entityId: '44444444-4444-4444-4444-444444444444', label: 'Étiquetage incorrect' });
    const row = await latestRow(entity);
    expect(row.action).toBe(`${entity.toUpperCase()}_CREATED`);
    expect(row.tenant_id).toBe(FAKE_USER_REQ.tenantId);
    expect(row.actor_id).toBe(FAKE_USER_REQ.user.id);
    expect(row.metadata).toEqual({ label: 'Étiquetage incorrect' });
  });

  it('logUpdate dérive ${ENTITY}_UPDATED, inclut changed_fields, ajoute status.from/to UNIQUEMENT si status a changé', async () => {
    const entity = uniqueEntity('test-activity-log-update');
    await logUpdate({
      req: FAKE_USER_REQ,
      entity,
      entityId: '55555555-5555-5555-5555-555555555555',
      label: 'Titre X',
      changedFields: ['title', 'status'],
      statusFrom: 'draft',
      statusTo: 'submitted',
    });
    const row = await latestRow(entity);
    expect(row.action).toBe(`${entity.toUpperCase()}_UPDATED`);
    expect(row.metadata).toEqual({ label: 'Titre X', changed_fields: ['title', 'status'], status: { from: 'draft', to: 'submitted' } });
  });

  it('logUpdate sans changement de status -> pas de champ status dans metadata', async () => {
    const entity = uniqueEntity('test-activity-log-update-no-status');
    await logUpdate({ req: FAKE_USER_REQ, entity, entityId: '66666666-6666-6666-6666-666666666666', changedFields: ['description'], statusFrom: 'draft', statusTo: 'draft' });
    const row = await latestRow(entity);
    expect(row.metadata).toEqual({ changed_fields: ['description'] });
  });

  it('logDelete dérive ${ENTITY}_DELETED', async () => {
    const entity = uniqueEntity('test-activity-log-delete');
    await logDelete({ req: FAKE_USER_REQ, entity, entityId: '77777777-7777-7777-7777-777777777777', label: 'À supprimer' });
    const row = await latestRow(entity);
    expect(row.action).toBe(`${entity.toUpperCase()}_DELETED`);
    expect(row.metadata).toEqual({ label: 'À supprimer' });
  });

  it('logTransition dérive ${ENTITY}_${VERBE}', async () => {
    const entity = uniqueEntity('test-activity-log-transition');
    await logTransition({ req: FAKE_USER_REQ, entity, verb: 'validated', entityId: '88888888-8888-8888-8888-888888888888', label: 'Procédure X' });
    const row = await latestRow(entity);
    expect(row.action).toBe(`${entity.toUpperCase()}_VALIDATED`);
  });

  it('logBulk dérive ${ENTITY}_BULK_${VERBE}, une seule ligne avec ids/count dans metadata (jamais une ligne par enregistrement)', async () => {
    const entity = uniqueEntity('test-activity-log-bulk');
    await logBulk({ req: FAKE_USER_REQ, entity, verb: 'deleted', ids: ['a', 'b', 'c'] });
    const row = await latestRow(entity);
    expect(row.action).toBe(`${entity.toUpperCase()}_BULK_DELETED`);
    expect(row.entity_id).toBeNull();
    expect(row.metadata).toEqual({ ids: ['a', 'b', 'c'], count: 3 });

    const { data: allRows } = await admin.from('activity_log').select('id').eq('entity_type', entity);
    expect(allRows).toHaveLength(1);
  });
});
