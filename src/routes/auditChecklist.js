import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { generateAuditChecklist } from '../services/groq.js';
import {
  CHECKLIST_ANSWERS,
  MAX_CHECKLIST_ITEMS,
  MAX_OBSERVATION_LENGTH,
  MAX_QUESTION_LENGTH,
  cleanQuestions,
  summarizeChecklist,
} from '../services/auditChecklist.js';

// Monté sur /api/audits à côté de routes/audits.js (voir app.js) : la check-list (QCM) d'un audit —
// questions saisies à la main ou générées par l'IA, réponses de l'auditeur pendant l'audit.
const router = Router();

// Garde route par route (jamais router.use) : ce routeur partage le préfixe /api/audits avec
// routes/audits.js, un router.use s'appliquerait à toutes les requêtes /api/audits/*.
const readGuards = [requireAuth, requireMenuVisible('audits')];
// Comme les constats : seuls admin/manager écrivent dans un audit.
const writeGuards = [...readGuards, requireRole('admin', 'manager')];

// Colonnes renvoyées partout (liste, ajout, modification) : la réponse porte aussi le nom de la personne qui a répondu.
const ITEM_SELECT = 'id, position, question, answer, observation, answered_at, answered_by, source, answerer:users!audit_checklist_items_answered_by_fkey(id, full_name)';

const AUDIT_TYPE_LABELS = { process: 'Audit de processus', product: 'Audit de produit', system: 'Audit système' };

// Audit du tenant, ou null s'il n'existe pas OU si sa catégorie est restreinte et inaccessible à
// l'appelant (même 404 dans les deux cas, comme GET /api/audits/:id).
async function findAudit(req) {
  const { data } = await supabase
    .from('audits')
    .select('id, title, audit_type, scope, category_id, service:services(name)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (!data) return null;
  const allowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  return allowed ? data : null;
}

async function loadItems(tenantId, auditId) {
  const { data, error } = await supabase
    .from('audit_checklist_items')
    .select(ITEM_SELECT)
    .eq('tenant_id', tenantId)
    .eq('audit_id', auditId)
    .order('position', { ascending: true });
  return { items: data || [], error };
}

function notFound(res) {
  return res.status(404).json({ error: 'Audit introuvable.' });
}

// GET /api/audits/:id/checklist — les questions avec leurs réponses, et le bilan.
router.get('/:id/checklist', readGuards, async (req, res) => {
  const audit = await findAudit(req);
  if (!audit) return notFound(res);
  const { items, error } = await loadItems(req.tenantId, audit.id);
  if (error) return res.status(500).json({ error: 'Impossible de récupérer la check-list.' });
  res.json({ items, summary: summarizeChecklist(items) });
});

// Insère des questions à la suite de celles existantes (position = dernier + 1…), dans la limite de
// MAX_CHECKLIST_ITEMS par audit. Retourne { created } ou { error, status }.
async function appendQuestions(req, audit, questions, source) {
  const { items: existing } = await loadItems(req.tenantId, audit.id);
  if (existing.length + questions.length > MAX_CHECKLIST_ITEMS) {
    return { status: 400, error: `Une check-list ne peut pas dépasser ${MAX_CHECKLIST_ITEMS} questions.` };
  }
  const start = existing.reduce((max, item) => Math.max(max, item.position), 0);
  const { data, error } = await supabase
    .from('audit_checklist_items')
    .insert(questions.map((question, index) => ({ tenant_id: req.tenantId, audit_id: audit.id, position: start + index + 1, question, source })))
    .select(ITEM_SELECT);
  if (error) return { status: 500, error: "Erreur lors de l'ajout des questions." };
  return { created: data };
}

// POST /api/audits/:id/checklist/items — ajoute une question saisie à la main.
router.post(
  '/:id/checklist/items',
  writeGuards,
  [body('question').isString().trim().isLength({ min: 1, max: MAX_QUESTION_LENGTH }).withMessage(`La question est requise (${MAX_QUESTION_LENGTH} caractères max).`)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const audit = await findAudit(req);
    if (!audit) return notFound(res);

    const result = await appendQuestions(req, audit, [req.body.question], 'manual');
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.created[0]);
  }
);

// POST /api/audits/:id/checklist/items/bulk — ajoute plusieurs questions d'un coup : liste collée
// (une question par ligne) ou questions de l'IA retenues après relecture (source 'ai').
router.post(
  '/:id/checklist/items/bulk',
  writeGuards,
  [
    body('questions').isArray({ min: 1, max: MAX_CHECKLIST_ITEMS }).withMessage(`Ajoutez entre 1 et ${MAX_CHECKLIST_ITEMS} questions.`),
    body('source').optional().isIn(['manual', 'ai']).withMessage('Source invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const audit = await findAudit(req);
    if (!audit) return notFound(res);

    const { items: existing } = await loadItems(req.tenantId, audit.id);
    const questions = cleanQuestions(req.body.questions, existing.map((item) => item.question));
    if (questions.length === 0) return res.status(400).json({ error: 'Aucune nouvelle question valide (vides, trop longues ou déjà présentes).' });

    const result = await appendQuestions(req, audit, questions, req.body.source || 'manual');
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json({ created: result.created });
  }
);

// PATCH /api/audits/:id/checklist/items/:itemId — modifie la question, la réponse et/ou l'observation.
// answer null remet la question « non répondue ».
router.patch(
  '/:id/checklist/items/:itemId',
  writeGuards,
  [
    body('question').optional().isString().trim().isLength({ min: 1, max: MAX_QUESTION_LENGTH }).withMessage(`La question est requise (${MAX_QUESTION_LENGTH} caractères max).`),
    body('answer').optional({ nullable: true }).isIn(CHECKLIST_ANSWERS).withMessage('Réponse invalide.'),
    body('observation').optional({ nullable: true }).isString().isLength({ max: MAX_OBSERVATION_LENGTH }).withMessage(`Observation trop longue (${MAX_OBSERVATION_LENGTH} caractères max).`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const audit = await findAudit(req);
    if (!audit) return notFound(res);

    const update = {};
    if ('question' in req.body) update.question = req.body.question;
    if ('observation' in req.body) update.observation = req.body.observation?.trim() || null;
    if ('answer' in req.body) {
      update.answer = req.body.answer || null;
      // Qui a répondu, et quand : mis à jour à chaque changement de réponse, effacé si on la retire.
      update.answered_by = update.answer ? req.user.id : null;
      update.answered_at = update.answer ? new Date().toISOString() : null;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    update.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('audit_checklist_items')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('audit_id', audit.id)
      .eq('id', req.params.itemId)
      .select(ITEM_SELECT)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    if (!data) return res.status(404).json({ error: 'Question introuvable.' });
    res.json(data);
  }
);

// DELETE /api/audits/:id/checklist/items/:itemId
router.delete('/:id/checklist/items/:itemId', writeGuards, async (req, res) => {
  const audit = await findAudit(req);
  if (!audit) return notFound(res);
  const { error, count } = await supabase
    .from('audit_checklist_items')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('audit_id', audit.id)
    .eq('id', req.params.itemId);
  if (error) return res.status(500).json({ error: 'Erreur lors de la suppression.' });
  if (!count) return res.status(404).json({ error: 'Question introuvable.' });
  res.status(204).end();
});

// POST /api/audits/:id/checklist/generate { count } — l'IA propose des questions à partir des
// informations de l'audit (titre, type, périmètre, service, procédures liées, constats). RIEN n'est
// enregistré : le frontend affiche la liste à relire ; les questions retenues sont ensuite ajoutées
// par POST .../items/bulk (source 'ai').
router.post(
  '/:id/checklist/generate',
  writeGuards,
  [body('count').optional().isInt({ min: 3, max: 25 }).withMessage('Demandez entre 3 et 25 questions.').toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const audit = await findAudit(req);
    if (!audit) return notFound(res);

    const count = req.body.count || 10;
    const [{ items: existing }, { data: findings }, { data: links }] = await Promise.all([
      loadItems(req.tenantId, audit.id),
      supabase.from('audit_findings').select('type, description').eq('tenant_id', req.tenantId).eq('audit_id', audit.id).order('created_at'),
      supabase.from('procedure_audit_links').select('procedure:procedures(number, title)').eq('tenant_id', req.tenantId).eq('audit_id', audit.id),
    ]);
    const existingQuestions = existing.map((item) => item.question);

    try {
      const result = await generateAuditChecklist({
        title: audit.title,
        typeLabel: AUDIT_TYPE_LABELS[audit.audit_type] || audit.audit_type,
        scope: audit.scope,
        service: audit.service?.name,
        linkedProcedures: (links || []).map((link) => [link.procedure?.number, link.procedure?.title].filter(Boolean).join(' — ')).filter(Boolean),
        findings: findings || [],
        existingQuestions,
        count,
      });
      const questions = cleanQuestions(result?.questions, existingQuestions).slice(0, count);
      if (questions.length === 0) {
        return res.status(503).json({ error: "L'IA n'a proposé aucune question exploitable. Réessayez ou complétez le périmètre de l'audit." });
      }
      res.json({ questions });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer les questions : ${err.message}` });
    }
  }
);

export default router;
