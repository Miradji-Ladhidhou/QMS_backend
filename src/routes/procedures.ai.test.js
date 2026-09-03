import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import * as groq from '../services/groq.js';
import { createProcedureFullDraftJob, runProcedureFullDraftJob } from '../services/procedureFullDraftJob.js';

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
    generateProcedureFullPlan: vi.fn(),
    generateProcedureSubsectionContent: vi.fn(),
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

// Crée le job directement via le service (pas via POST /generate-full-draft) : cette route
// lance elle-même runProcedureFullDraftJob en fire-and-forget dès l'appel, ce qui entrerait en
// concurrence avec l'appel explicite fait par ces tests (deux exécutions du pipeline se
// disputeraient les mêmes mockResolvedValueOnce). Le comportement fire-and-forget de la route
// elle-même est vérifié séparément, sans mock, dans le describe ci-dessous.
async function createJobDirectly(tenant, subject, sectionStructure) {
  return createProcedureFullDraftJob({
    tenantId: tenant.tenantId,
    userId: tenant.admin.id,
    subject,
    template: { section_structure: sectionStructure, fixed_instructions: null },
  });
}

describe('runProcedureFullDraftJob (pipeline multi-appels, IA mockée)', () => {
  it('assemble un document complet, une entrée par section du gabarit dans l’ordre, avec la continuité du résumé glissant', async () => {
    tenant = await createTenant();

    groq.generateProcedureFullPlan.mockResolvedValueOnce({
      objet: 'Objet complet',
      domaine_application: 'Domaine complet',
      responsabilites: 'Responsabilités complètes',
      documents_associes: ['Fiche de suivi'],
      plan: [{ key: 'processus', label: 'Processus', subsections: ['Réception', 'Contrôle final'] }],
    });
    groq.generateProcedureSubsectionContent
      .mockResolvedValueOnce({
        intro: 'Introduction de la réception.',
        actions: [{ text: 'Vérifier le bon de commande.', sub_bullets: [] }],
        summary_sentence: 'La réception a été décrite.',
        callout: null,
      })
      .mockResolvedValueOnce({
        intro: 'Introduction du contrôle final.',
        actions: [{ text: 'Contrôler la conformité.', sub_bullets: ['Vérifier le poids'] }],
        summary_sentence: 'Le contrôle final a été décrit.',
        callout: { severity: 'danger', text: 'Ne jamais expédier un colis non contrôlé.' },
      });

    const job = await createJobDirectly(tenant, 'procédure de préparation de commande', [
      { key: 'processus', label: 'Processus' },
    ]);
    expect(job.status).toBe('pending');

    await runProcedureFullDraftJob(job.id);

    const jobRes = await request(app)
      .get(`/api/procedures/generation-jobs/${job.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe('completed');
    expect(jobRes.body.completed_steps).toBe(2);
    expect(jobRes.body.total_steps).toBe(2);

    const { result } = jobRes.body;
    expect(result.objet).toBe('Objet complet');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].key).toBe('processus');
    expect(result.sections[0].subsections).toHaveLength(2);
    expect(result.sections[0].content).toContain('Réception');
    expect(result.sections[0].content).toContain('Contrôle final');
    expect(result.sections[0].content).toContain('Danger : Ne jamais expédier un colis non contrôlé.');

    // Continuité : le 2e appel de sous-section reçoit le résumé du 1er.
    const secondCallArgs = groq.generateProcedureSubsectionContent.mock.calls[1][0];
    expect(secondCallArgs.rollingSummary).toContain('La réception a été décrite.');
    expect(secondCallArgs.wantsCallout).toBe(true); // "Contrôle final" contient le mot-clé "contrôle"
  });

  it('ne fait pas échouer tout le document si une sous-section échoue — la marque à compléter manuellement et continue', async () => {
    tenant = await createTenant();

    groq.generateProcedureFullPlan.mockResolvedValueOnce({
      objet: 'Objet',
      domaine_application: 'Domaine',
      responsabilites: 'Responsabilités',
      documents_associes: [],
      plan: [{ key: 'processus', label: 'Processus', subsections: ['Étape 1', 'Étape 2'] }],
    });
    groq.generateProcedureSubsectionContent
      .mockRejectedValueOnce(new Error('Réponse Groq mal formée.'))
      .mockResolvedValueOnce({
        intro: 'Introduction étape 2.',
        actions: [{ text: 'Action de l’étape 2.', sub_bullets: [] }],
        summary_sentence: 'Étape 2 décrite.',
        callout: null,
      });

    const job = await createJobDirectly(tenant, 'procédure de test', [{ key: 'processus', label: 'Processus' }]);

    await runProcedureFullDraftJob(job.id);

    const jobRes = await request(app)
      .get(`/api/procedures/generation-jobs/${job.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(jobRes.body.status).toBe('completed');
    expect(groq.generateProcedureSubsectionContent).toHaveBeenCalledTimes(2);
    expect(jobRes.body.failed_subsections).toEqual([{ section_key: 'processus', subsection_title: 'Étape 1' }]);
    expect(jobRes.body.result.sections[0].content).toContain('À compléter manuellement');
    expect(jobRes.body.result.sections[0].content).toContain('Étape 2 décrite'.split(' ')[0]);
  });

  it('échec total si l’étape de plan échoue — status failed, aucun appel de sous-section', async () => {
    tenant = await createTenant();
    groq.generateProcedureFullPlan.mockRejectedValueOnce(new Error('Quota Groq dépassé : réessayez plus tard.'));

    const job = await createJobDirectly(tenant, 'procédure de test', [{ key: 'processus', label: 'Processus' }]);

    await runProcedureFullDraftJob(job.id);

    const jobRes = await request(app)
      .get(`/api/procedures/generation-jobs/${job.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(jobRes.body.status).toBe('failed');
    expect(jobRes.body.error).toContain('Quota Groq');
    expect(groq.generateProcedureSubsectionContent).not.toHaveBeenCalled();
  });
});

describe('POST /api/procedures/generate-full-draft (validation, garde-fou, isolation)', () => {
  it('400 sur un sujet vide ou trop court', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/procedures/generate-full-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject: 'ab' });
    expect(res.status).toBe(400);
    expect(groq.generateProcedureFullPlan).not.toHaveBeenCalled();
  });

  it('429 au-delà de 15 générations complètes dans les dernières 24h, sans compter une génération plus ancienne', async () => {
    tenant = await createTenant();

    const recentRows = Array.from({ length: 15 }, () => ({
      tenant_id: tenant.tenantId,
      subject: 'sujet',
      template_snapshot: { section_structure: [] },
      status: 'completed',
    }));
    await admin.from('procedure_generation_jobs').insert(recentRows);
    await admin.from('procedure_generation_jobs').insert({
      tenant_id: tenant.tenantId,
      subject: 'ancien',
      template_snapshot: { section_structure: [] },
      status: 'completed',
      created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const res = await request(app)
      .post('/api/procedures/generate-full-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject: 'un sujet valide' });
    expect(res.status).toBe(429);
  });

  it('isole les jobs par tenant (404 depuis un autre tenant) et 404 sur un id inconnu', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      groq.generateProcedureFullPlan.mockResolvedValueOnce({
        objet: 'Objet',
        domaine_application: 'Domaine',
        responsabilites: 'Responsabilités',
        documents_associes: [],
        plan: [],
      });

      const postRes = await request(app)
        .post('/api/procedures/generate-full-draft')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ subject: 'un sujet valide' });
      expect(postRes.status).toBe(202);

      const foreign = await request(app)
        .get(`/api/procedures/generation-jobs/${postRes.body.id}`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(foreign.status).toBe(404);

      const unknown = await request(app)
        .get('/api/procedures/generation-jobs/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(unknown.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
