import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { getProcedureReviewAlerts } from './notificationJob.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// Même calcul que addDaysIso dans notificationJob.js (non exportée) — dupliqué ici pour
// construire des dates de test qui tombent exactement sur un seuil ou juste à côté.
function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

describe('getProcedureReviewAlerts', () => {
  it('détecte une procédure dont la prochaine révision tombe pile dans 30, 15 ou 7 jours, jamais hors de ces fenêtres', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-J30', { next_review_date: addDaysIso(30) });
    await createProcedure(tenant.admin.token, 'PROC-J15', { next_review_date: addDaysIso(15) });
    await createProcedure(tenant.admin.token, 'PROC-J7', { next_review_date: addDaysIso(7) });
    // Ni pile sur un seuil (10 jours, entre 15 et 7) ni sans date du tout : aucun des deux ne
    // doit jamais être remonté par le job.
    await createProcedure(tenant.admin.token, 'PROC-J10', { next_review_date: addDaysIso(10) });
    await createProcedure(tenant.admin.token, 'PROC-JNONE');

    const alerts = await getProcedureReviewAlerts(tenant.tenantId);
    const byNumber = new Map(alerts.map((alert) => [alert.number, alert]));

    expect(byNumber.get('PROC-J30')?.days_remaining).toBe(30);
    expect(byNumber.get('PROC-J15')?.days_remaining).toBe(15);
    expect(byNumber.get('PROC-J7')?.days_remaining).toBe(7);
    expect(byNumber.has('PROC-J10')).toBe(false);
    expect(byNumber.has('PROC-JNONE')).toBe(false);
  });
});
