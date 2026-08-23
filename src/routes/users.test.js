import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('Registration and role model', () => {
  it('le fondateur du tenant est "admin", pas "owner" (rôle fusionné)', async () => {
    tenant = await createTenant();
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(me.body.role).toBe('admin');
  });

  it('la base rejette "owner" comme valeur de rôle (contrainte retirée)', async () => {
    tenant = await createTenant();
    const { error } = await admin.from('users').update({ role: 'owner' }).eq('id', tenant.admin.id);
    expect(error).not.toBeNull();
  });
});

describe('PATCH /api/users/:id — gestion symétrique entre admins', () => {
  it('un admin peut changer le rôle et désactiver un autre admin (plus de rôle protégé)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'admin' }] });
    const secondAdmin = tenant.users[0];

    // Déactivation d'abord : les deux sont encore admins à ce stade. Le rôle du fondateur
    // n'est changé qu'ensuite — le faire avant aurait fait perdre à son propre token le
    // droit d'appeler cette route admin-only pour l'étape suivante.
    const deactivate = await request(app)
      .patch(`/api/users/${secondAdmin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.is_active).toBe(false);

    const blocked = await request(app).get('/api/users/me').set('Authorization', `Bearer ${secondAdmin.token}`);
    expect(blocked.status).toBe(403);

    const reactivate = await request(app)
      .patch(`/api/users/${secondAdmin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: true });
    expect(reactivate.status).toBe(200);

    const roleChange = await request(app)
      .patch(`/api/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${secondAdmin.token}`)
      .send({ role: 'manager' });
    expect(roleChange.status).toBe(200);
    expect(roleChange.body.role).toBe('manager');
  });

  it('un utilisateur ne peut jamais se désactiver lui-même, quel que soit son rôle', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .patch(`/api/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });
    expect(res.status).toBe(403);
  });

  it('member bloqué (403) sur la modification d’un autre utilisateur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const res = await request(app)
      .patch(`/api/users/${manager.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
  });
});

describe('Invitation lifecycle', () => {
  it('GET /users expose email + invitation_pending, et /resend-invite fonctionne', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const list = await request(app).get('/api/users').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = list.body.find((u) => u.id === member.id);
    expect(row.email).toBe(member.email);
    expect(row.invitation_pending).toBe(true);

    const resend = await request(app)
      .post(`/api/users/${member.id}/resend-invite`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(resend.status).toBe(200);

    const forbidden = await request(app)
      .post(`/api/users/${member.id}/resend-invite`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(forbidden.status).toBe(403);
  });
});

describe('DELETE /api/users/:id — suppression définitive', () => {
  it('un admin peut supprimer définitivement un membre, et son email redevient disponible', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const del = await request(app).delete(`/api/users/${member.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const { data: authUser } = await admin.auth.admin.getUserById(member.id);
    expect(authUser?.user).toBeNull();

    const { data: profile } = await admin.from('users').select('id').eq('id', member.id).maybeSingle();
    expect(profile).toBeNull();

    // L'email libéré doit permettre une nouvelle invitation, exactement le scénario rapporté
    // ("email déjà existant" alors que le compte avait été désactivé, pas supprimé).
    const reinvite = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ email: member.email, full_name: 'Nouveau titulaire', role: 'member' });
    expect(reinvite.status).toBe(201);
  });

  it('un admin ne peut pas supprimer son propre compte', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .delete(`/api/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it('un manager/member ne peut pas supprimer un compte', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;

    const res = await request(app)
      .delete(`/api/users/${member.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });

  it("un id d'un autre tenant renvoie 404 (jamais un signal qu'il existe ailleurs)", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const res = await request(app)
        .delete(`/api/users/${otherTenant.admin.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(res.status).toBe(404);

      const { data: stillThere } = await admin.auth.admin.getUserById(otherTenant.admin.id);
      expect(stillThere?.user).not.toBeNull();
    } finally {
      await otherTenant.cleanup();
    }
  });

  it("l'historique d'approbation d'un document survit à la suppression du compte de l'approbateur (decision/signature conservés, identité perdue)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const { data: doc } = await admin
      .from('documents')
      .insert({ tenant_id: tenant.tenantId, number: 'DOC-APPROVAL-TEST', title: 'Document de test' })
      .select()
      .single();

    const { data: workflow } = await admin
      .from('document_workflows')
      .insert({
        tenant_id: tenant.tenantId,
        document_id: doc.id,
        required_approvers: [manager.id],
        status: 'approved',
      })
      .select()
      .single();

    const { data: approval } = await admin
      .from('document_approvals')
      .insert({
        tenant_id: tenant.tenantId,
        workflow_id: workflow.id,
        approver_id: manager.id,
        decision: 'approved',
        decided_at: new Date().toISOString(),
        signature_hash: 'test-signature-hash',
      })
      .select()
      .single();

    const del = await request(app).delete(`/api/users/${manager.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const { data: survivingApproval } = await admin
      .from('document_approvals')
      .select('approver_id, decision, signature_hash, decided_at')
      .eq('id', approval.id)
      .single();
    expect(survivingApproval.approver_id).toBeNull();
    expect(survivingApproval.decision).toBe('approved');
    expect(survivingApproval.signature_hash).toBe('test-signature-hash');
    expect(survivingApproval.decided_at).not.toBeNull();
  });
});

describe('Removed features stay removed', () => {
  it('POST /users/:id/transfer-ownership n’existe plus (404)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const res = await request(app)
      .post(`/api/users/${tenant.users[0].id}/transfer-ownership`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(404);
  });

  it('GET/DELETE /api/tenant/export et /api/tenant n’existent plus (404)', async () => {
    tenant = await createTenant();
    const exportRes = await request(app).get('/api/tenant/export').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(exportRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete('/api/tenant')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ confirm_name: tenant.companyName });
    expect(deleteRes.status).toBe(404);
  });
});
