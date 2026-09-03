import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import * as groq from '../services/groq.js';

// Première introduction du mock dans ce projet (voir le reste de la suite Procédures, qui
// vérifie les chemins permission/validation et laisse l'appel IA réel "vérifié manuellement",
// même convention que risks.test.js/haccp.test.js) — isolée dans ce fichier séparé plutôt que
// mélangée à procedures.test.js, pour que le gros de la suite reste un test d'intégration
// réel sans mock global. Seules les 4 fonctions procédures de groq.js sont remplacées ; le
// reste du module (utilisé par d'autres routeurs chargés par app.js) garde son implémentation
// réelle grâce à importOriginal.
vi.mock('../services/groq.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateProcedureDraft: vi.fn(),
    generateProcedureDraftFromQqoqccp: vi.fn(),
    checkProcedureTemplateCompliance: vi.fn(),
    generateProcedureDistributionSheet: vi.fn(),
    suggestProcedureRevisionFromCapa: vi.fn(),
  };
});

let tenant;

afterEach(async () => {
  vi.clearAllMocks();
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function createVersion(token, procedureId, extra = {}) {
  const res = await request(app)
    .post(`/api/procedures/${procedureId}/versions`)
    .set('Authorization', `Bearer ${token}`)
    .send(extra);
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/procedures/generate-draft (IA mockée)', () => {
  it('appelle le service avec le titre/processus et le gabarit du tenant, renvoie la réponse telle quelle', async () => {
    tenant = await createTenant();
    await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'etapes', label: 'Étapes du processus' }] })
      .expect(200);

    const mockDraft = {
      objet: 'Objet généré par l’IA',
      domaine_application: 'Domaine généré',
      responsabilites: 'Responsabilités générées',
      sections: [{ key: 'etapes', label: 'Étapes du processus', content: 'Contenu généré' }],
      documents_associes: [],
    };
    groq.generateProcedureDraft.mockResolvedValueOnce(mockDraft);

    const res = await request(app)
      .post('/api/procedures/generate-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Gestion des non-conformités', process: 'Qualité' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockDraft);

    expect(groq.generateProcedureDraft).toHaveBeenCalledTimes(1);
    const [formData, template] = groq.generateProcedureDraft.mock.calls[0];
    expect(formData).toEqual({ title: 'Gestion des non-conformités', process: 'Qualité' });
    expect(template.section_structure).toEqual([{ key: 'etapes', label: 'Étapes du processus' }]);
  });

  it('renvoie 503 (jamais un crash) quand le service IA échoue sur une réponse malformée', async () => {
    tenant = await createTenant();
    groq.generateProcedureDraft.mockRejectedValueOnce(
      new Error('Réponse Groq mal formée : impossible de générer une suggestion.')
    );

    const res = await request(app)
      .post('/api/procedures/generate-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Titre quelconque' });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('brouillon IA');
  });
});

describe('POST /api/procedures/generate-draft-from-qqoqccp (IA mockée)', () => {
  it('appelle le service avec l’analyse QQOQCCP et le gabarit, reprend le titre de l’analyse, refuse une analyse d’un autre tenant', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await request(app)
        .put('/api/procedure-templates')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ section_structure: [{ key: 'etapes', label: 'Étapes' }] })
        .expect(200);

      const analysisRes = await request(app)
        .post('/api/qqoqccp')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({
          title: 'Erreurs répétées de saisie',
          quoi: 'Des étiquettes mal renseignées',
          pourquoi: "Aucune procédure ne décrit l'étape de vérification",
        });
      expect(analysisRes.status).toBe(201);
      const analysis = analysisRes.body;

      const mockDraft = {
        objet: 'Objet généré depuis le diagnostic',
        domaine_application: 'Domaine généré',
        responsabilites: 'Responsabilités générées',
        sections: [{ key: 'etapes', label: 'Étapes', content: 'Contenu généré' }],
        documents_associes: [],
      };
      groq.generateProcedureDraftFromQqoqccp.mockResolvedValueOnce(mockDraft);

      const res = await request(app)
        .post('/api/procedures/generate-draft-from-qqoqccp')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ qqoqccp_id: analysis.id });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Erreurs répétées de saisie');
      expect(res.body.sections).toEqual(mockDraft.sections);

      expect(groq.generateProcedureDraftFromQqoqccp).toHaveBeenCalledTimes(1);
      const [analysisArg, template] = groq.generateProcedureDraftFromQqoqccp.mock.calls[0];
      expect(analysisArg.quoi).toBe('Des étiquettes mal renseignées');
      expect(analysisArg.pourquoi).toBe("Aucune procédure ne décrit l'étape de vérification");
      expect(template.section_structure).toEqual([{ key: 'etapes', label: 'Étapes' }]);

      const foreignAttempt = await request(app)
        .post('/api/procedures/generate-draft-from-qqoqccp')
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({ qqoqccp_id: analysis.id });
      expect(foreignAttempt.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('POST /api/procedures/:id/versions/:versionId/check-compliance (IA mockée)', () => {
  it('appelle le service avec le contenu de la version et le gabarit du tenant, renvoie la réponse telle quelle', async () => {
    tenant = await createTenant();
    await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'etapes', label: 'Étapes' }] })
      .expect(200);

    const procedure = await createProcedure(tenant.admin.token, 'PROC-A01');
    const version = await createVersion(tenant.admin.token, procedure.id, {
      content: { sections: [{ key: 'etapes', label: 'Étapes', content: 'Texte de la section' }] },
    });

    const mockResult = { compliant: false, anomalies: [{ section_key: 'etapes', issue: 'Trop vague', severity: 'minor' }] };
    groq.checkProcedureTemplateCompliance.mockResolvedValueOnce(mockResult);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/check-compliance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockResult);

    expect(groq.checkProcedureTemplateCompliance).toHaveBeenCalledTimes(1);
    const [content, template] = groq.checkProcedureTemplateCompliance.mock.calls[0];
    expect(content.sections[0].content).toBe('Texte de la section');
    expect(template.section_structure).toEqual([{ key: 'etapes', label: 'Étapes' }]);
  });

  it('renvoie 503 (jamais un crash) sur une réponse IA malformée', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-A02');
    const version = await createVersion(tenant.admin.token, procedure.id);
    groq.checkProcedureTemplateCompliance.mockRejectedValueOnce(new Error('Réponse Groq mal formée.'));

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/check-compliance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(503);
  });
});

describe('POST /api/procedures/:id/versions/:versionId/distribution-sheet (IA mockée)', () => {
  it('refusée sur un brouillon (409), acceptée sur une version approuvée, persistée et retrouvable via le détail', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-A03');
    const version = await createVersion(tenant.admin.token, procedure.id, { content: { objet: 'Objet' } });

    const tooEarly = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/distribution-sheet`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ target_audience: 'Nouveaux opérateurs' });
    expect(tooEarly.status).toBe(409);
    expect(groq.generateProcedureDistributionSheet).not.toHaveBeenCalled();

    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const mockSheet = {
      summary: 'Résumé condensé de la procédure.',
      key_points: ['Point clé 1', 'Point clé 2'],
      audience_notes: 'Concerne particulièrement les nouveaux opérateurs.',
    };
    groq.generateProcedureDistributionSheet.mockResolvedValueOnce(mockSheet);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/distribution-sheet`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ target_audience: 'Nouveaux opérateurs' });

    expect(res.status).toBe(200);
    expect(res.body.distribution_sheet.summary).toBe(mockSheet.summary);
    expect(res.body.distribution_sheet.key_points).toEqual(mockSheet.key_points);
    expect(res.body.distribution_sheet.target_audience).toBe('Nouveaux opérateurs');

    expect(groq.generateProcedureDistributionSheet).toHaveBeenCalledWith(
      expect.objectContaining({ objet: 'Objet' }),
      'Nouveaux opérateurs'
    );

    const detail = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.versions.find((v) => v.id === version.id).distribution_sheet.summary).toBe(mockSheet.summary);
  });
});

describe('POST /api/procedures/:id/suggest-revision-from-capa (IA mockée)', () => {
  it('appelle le service avec les données du CAPA lié et le contenu courant, refuse un CAPA non lié', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-A04');
    const version = await createVersion(tenant.admin.token, procedure.id, { content: { objet: 'Objet actuel' } });
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const capaRes = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        title: 'Non-conformité récurrente',
        root_cause: 'Étape manquante dans la procédure',
        corrective_action: 'Corriger la non-conformité constatée',
        preventive_action: 'Mettre à jour la procédure',
      });
    expect(capaRes.status).toBe(201);
    const capa = capaRes.body;

    const notLinked = await request(app)
      .post(`/api/procedures/${procedure.id}/suggest-revision-from-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capa_id: capa.id });
    expect(notLinked.status).toBe(404);
    expect(groq.suggestProcedureRevisionFromCapa).not.toHaveBeenCalled();

    await request(app)
      .post(`/api/procedures/${procedure.id}/link-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capa_id: capa.id })
      .expect(201);

    const mockSuggestion = {
      rationale: 'La cause racine révèle une étape manquante.',
      suggested_changes: [{ section_key: 'objet', current_excerpt: 'Objet actuel', suggested_content: 'Objet révisé' }],
    };
    groq.suggestProcedureRevisionFromCapa.mockResolvedValueOnce(mockSuggestion);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/suggest-revision-from-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capa_id: capa.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockSuggestion);

    expect(groq.suggestProcedureRevisionFromCapa).toHaveBeenCalledTimes(1);
    const [capaData, currentContent] = groq.suggestProcedureRevisionFromCapa.mock.calls[0];
    expect(capaData.title).toBe('Non-conformité récurrente');
    expect(capaData.root_cause).toBe('Étape manquante dans la procédure');
    expect(currentContent.objet).toBe('Objet actuel');
  });
});
