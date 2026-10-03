import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

const aiMocks = vi.hoisted(() => ({
  generateHaccpSurveillanceSuggestion: vi.fn(),
  generateHaccpSignificanceSuggestion: vi.fn(),
}));
vi.mock('../services/groq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateHaccpSurveillanceSuggestion: aiMocks.generateHaccpSurveillanceSuggestion,
  generateHaccpSignificanceSuggestion: aiMocks.generateHaccpSignificanceSuggestion,
}));

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// POST /api/ai/capa-suggestion appelle Groq en direct : comme pour POST /qqoqccp/:id/generate,
// aucun test automatisé ne couvre le chemin qui appelle réellement l'IA (vérifié manuellement
// via curl/Playwright). On couvre ici uniquement l'authentification et la validation d'entrée,
// qui ne nécessitent pas d'appel réseau.
describe('POST /api/ai/capa-suggestion — authentification et validation', () => {
  it('401 sans authentification', async () => {
    const res = await request(app).post('/api/ai/capa-suggestion').send({ context: 'Un contexte suffisamment long.' });
    expect(res.status).toBe(401);
  });

  it('400 si le contexte est trop court, pour tout rôle (aucune restriction de rôle sur cette route)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/ai/capa-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ context: 'court' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// Même principe que POST /api/ai/capa-suggestion ci-dessus : POST /api/ai/risk-treatment-suggestion
// appelle Groq en direct, non couvert par un test automatisé — uniquement l'authentification et
// la validation d'entrée ici.
describe('POST /api/ai/risk-treatment-suggestion — authentification et validation', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/ai/risk-treatment-suggestion')
      .send({ title: 'Panne serveur', likelihood: 3, impact: 4 });
    expect(res.status).toBe(401);
  });

  it('400 si le titre est manquant, pour tout rôle (aucune restriction de rôle sur cette route)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/ai/risk-treatment-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ likelihood: 3, impact: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('400 si probabilité/gravité sont hors de 1-5', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/ai/risk-treatment-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Panne serveur', likelihood: 9, impact: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// Même principe que les routes IA ci-dessus : POST /api/ai/haccp-significance-suggestion et
// POST /api/ai/haccp-ccp-suggestion appellent Groq en direct, non couverts par un test
// automatisé — uniquement l'authentification et la validation d'entrée ici.
describe('POST /api/ai/haccp-significance-suggestion — authentification et validation', () => {
  it('renvoie les deux décisions indépendantes et refuse une réponse IA incomplète', async () => {
    tenant = await createTenant();
    const call = () => request(app)
      .post('/api/ai/haccp-significance-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ hazardType: 'biological', description: 'Listeria', likelihood: 2, severity: 4 });
    for (const [is_significant, control_type] of [[true, 'prp'], [false, 'ccp']]) {
      const suggestion = {
        is_significant,
        control_type,
        justification: 'Le risque est évalué selon les critères documentés.',
        decision_justification: 'La maîtrise est choisie indépendamment de la cotation du risque.',
      };
      aiMocks.generateHaccpSignificanceSuggestion.mockResolvedValue(suggestion);
      const res = await call();
      expect(res.status).toBe(200);
      expect(res.body).toEqual(suggestion);
    }
    aiMocks.generateHaccpSignificanceSuggestion.mockResolvedValue({ is_significant: true, justification: 'Risque significatif.' });
    expect((await call()).status).toBe(503);
    aiMocks.generateHaccpSignificanceSuggestion.mockResolvedValue({
      is_significant: true,
      control_type: 'invalid',
      justification: 'Risque significatif.',
      decision_justification: 'Décision invalide.',
    });
    expect((await call()).status).toBe(503);
  });

  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/ai/haccp-significance-suggestion')
      .send({ hazardType: 'biological', description: 'Listeria', likelihood: 2, severity: 4 });
    expect(res.status).toBe(401);
  });

  it('400 si le type de danger est invalide', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/ai/haccp-significance-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ hazardType: 'radioactive', description: 'Listeria', likelihood: 2, severity: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('400 si la description est manquante', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/ai/haccp-significance-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ hazardType: 'biological', likelihood: 2, severity: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('POST /api/ai/haccp-ccp-suggestion — authentification et validation', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/ai/haccp-ccp-suggestion')
      .send({ hazardType: 'biological', description: 'Listeria', likelihood: 2, severity: 4 });
    expect(res.status).toBe(401);
  });

  it('400 si probabilité/gravité sont hors de 1-5', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/ai/haccp-ccp-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ hazardType: 'biological', description: 'Listeria', likelihood: 2, severity: 12 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('POST /api/ai/haccp-surveillance-suggestion — authentification et validation', () => {
  it('401 sans authentification', async () => {
    const res = await request(app).post('/api/ai/haccp-surveillance-suggestion').send({ planTitle: 'Plan HACCP', steps: [] });
    expect(res.status).toBe(401);
  });

  it('403 pour un rôle sans permission de gestion HACCP', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/ai/haccp-surveillance-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ planTitle: 'Plan HACCP', steps: [] });
    expect(res.status).toBe(403);
  });

  it('400 si les étapes ne contiennent aucun danger', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/ai/haccp-surveillance-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ planTitle: 'Plan HACCP', steps: [{ name: 'Stockage', hazards: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('400 si un danger contient un type ou une cotation invalide', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/ai/haccp-surveillance-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        planTitle: 'Plan HACCP',
        steps: [
          {
            name: 'Stockage',
            hazards: [
              {
                hazard_type: 'radiologique',
                id: '8728f32a-d4b7-46b2-8ebd-dec3aba830af',
                description: 'Danger non reconnu',
                likelihood: 8,
                severity: 3,
                is_significant: false,
                has_ccp: false,
              },
            ],
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('sépare la significativité du contrôle et ne retourne des propositions que pour les choix CCP', async () => {
    tenant = await createTenant();
    const hazardIds = ['8728f32a-d4b7-46b2-8ebd-dec3aba830af', '8728f32a-d4b7-46b2-8ebd-dec3aba830ae'];
    const ccpText = {
      critical_limits: 'À confirmer par essai',
      monitoring_procedure: '',
      monitoring_frequency: '',
      corrective_action_procedure: '',
      verification_procedure: '',
      verification_frequency: '',
      record_keeping_procedure: '',
    };
    aiMocks.generateHaccpSurveillanceSuggestion.mockResolvedValue({
      summary: 'Analyse de risques et des contrôles.',
      suggestions: [
        {
          hazard_id: hazardIds[0],
          is_significant: true,
          control_type: 'prp',
          decision_justification: 'Les bonnes pratiques contrôlent ce danger.',
          justification: 'Les bonnes pratiques contrôlent ce danger.',
          routine_monitoring: 'Vérifier la mise en œuvre des bonnes pratiques.',
          routine_frequency: 'Chaque semaine',
          ...ccpText,
        },
        {
          hazard_id: hazardIds[1],
          is_significant: false,
          control_type: 'ccp',
          decision_justification: 'Une limite critique est retenue malgré le score de risque.',
          justification: 'Une limite critique est retenue malgré le score de risque.',
          routine_monitoring: '',
          routine_frequency: '',
          ...ccpText,
        },
      ],
    });
    const res = await request(app)
      .post('/api/ai/haccp-surveillance-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        planTitle: 'Plan HACCP',
        steps: [{
          name: 'Stockage',
          hazards: hazardIds.map((id) => ({
            id,
            hazard_type: 'biological',
            description: 'Danger microbiologique',
            likelihood: 2,
            severity: 3,
            is_significant: false,
            has_ccp: false,
          })),
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map(({ is_significant, control_type }) => [is_significant, control_type])).toEqual([
      [true, 'prp'],
      [false, 'ccp'],
    ]);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0]).toMatchObject({ hazard_id: hazardIds[1], ai_generated: true });
  });
});
