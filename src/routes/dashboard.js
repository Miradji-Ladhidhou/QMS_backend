import { Router } from 'express';
import { query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Mêmes fenêtres que documents.js (/alerts) et trainings.js (/upcoming-renewals), pour
// rester cohérent avec les indicateurs déjà affichés ailleurs dans l'application.
const RENEWAL_WINDOW_DAYS = 60;
const DOCUMENT_REVIEW_WINDOW_DAYS = 30;

router.use(requireAuth);

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function countCapasByStatus(capas) {
  const counts = { open: 0, in_progress: 0, overdue: 0, closed: 0 };
  for (const capa of capas) {
    if (capa.status in counts) {
      counts[capa.status] += 1;
    }
  }
  return counts;
}

async function fetchUserServiceIds(tenantId, userId) {
  const { data, error } = await supabase
    .from('user_services')
    .select('service_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);

  if (error) return [];
  return data.map((row) => row.service_id);
}

// Les formations n'ont pas de service_id propre, mais leurs réalisations sont rattachées à
// un utilisateur — filtrer "par service" revient à filtrer sur les membres de l'équipe.
async function fetchServiceUserIds(tenantId, serviceIds) {
  if (serviceIds.length === 0) return [];

  const { data, error } = await supabase
    .from('user_services')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .in('service_id', serviceIds);

  if (error) return [];
  return [...new Set(data.map((row) => row.user_id))];
}

// userIds === null : pas de filtre (tout le tenant). userIds === [] : filtre vide (aucun
// utilisateur concerné, ex. manager sans service) — on court-circuite plutôt que d'envoyer
// un .in() vide dont le comportement varie selon le client.
async function countTrainingsToRenew(tenantId, userIds) {
  if (userIds && userIds.length === 0) return 0;

  let recordsQuery = supabase
    .from('training_records')
    .select('training_id, user_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);

  if (userIds) {
    recordsQuery = recordsQuery.in('user_id', userIds);
  }

  const { data, error } = await recordsQuery;
  if (error || !data) return 0;

  const latestByPair = new Map();
  for (const record of data) {
    const key = `${record.training_id}:${record.user_id}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  const threshold = isoDateInDays(RENEWAL_WINDOW_DAYS);
  let count = 0;
  for (const record of latestByPair.values()) {
    if (record.next_due_date && record.next_due_date <= threshold) {
      count += 1;
    }
  }
  return count;
}

async function countDocumentsToReview(tenantId) {
  const threshold = isoDateInDays(DOCUMENT_REVIEW_WINDOW_DAYS);
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .lte('review_date', threshold);

  if (error) return 0;
  return count || 0;
}

// GET /api/dashboard/stats — indicateurs agrégés {capas, documents, trainings}, filtrage
// par service selon le rôle :
// - admin : tout le tenant par défaut, filtrable ponctuellement via ?service_id=
// - manager : filtré automatiquement sur ses services (table user_services, prompt B2) si
//   aucun service_id n'est fourni ; un service_id explicite hors périmètre est autorisé
//   (vue élargie ponctuelle) sans changer son filtrage par défaut aux prochains appels —
//   rien n'est mémorisé côté serveur, chaque appel est indépendant
// - member : uniquement ses propres CAPA assignées et ses propres formations, jamais de vue
//   tenant ou service ; documents.to_review reste à 0 pour ce rôle — les documents n'ont pas
//   de porteur individuel dans le schéma, pas de métrique personnelle à calculer ici
router.get(
  '/stats',
  [query('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const requestedServiceId = req.query.service_id || null;

    if (req.userRole === 'member') {
      const { data: capas, error: capasError } = await supabase
        .from('capas')
        .select('status')
        .eq('tenant_id', req.tenantId)
        .eq('assigned_to', req.user.id);

      if (capasError) {
        return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
      }

      const trainingsToRenew = await countTrainingsToRenew(req.tenantId, [req.user.id]);

      return res.json({
        capas: countCapasByStatus(capas),
        documents: { to_review: 0 },
        trainings: { to_renew: trainingsToRenew },
      });
    }

    // admin / manager : détermine le(s) service(s) à filtrer — null signifie "tout le tenant".
    let serviceIds = null;
    if (requestedServiceId) {
      serviceIds = [requestedServiceId];
    } else if (req.userRole === 'manager') {
      serviceIds = await fetchUserServiceIds(req.tenantId, req.user.id);
    }

    let capas = [];
    if (!serviceIds || serviceIds.length > 0) {
      let capasQuery = supabase.from('capas').select('status').eq('tenant_id', req.tenantId);
      if (serviceIds) {
        capasQuery = capasQuery.in('service_id', serviceIds);
      }
      const { data, error } = await capasQuery;
      if (error) {
        return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
      }
      capas = data;
    }

    // Les documents n'ont pas de service_id (voir schema.sql) : aucun filtrage possible,
    // le compte reste celui du tenant entier quel que soit service_id.
    const documentsToReview = await countDocumentsToReview(req.tenantId);

    const trainingUserIds = serviceIds ? await fetchServiceUserIds(req.tenantId, serviceIds) : null;
    const trainingsToRenew = await countTrainingsToRenew(req.tenantId, trainingUserIds);

    res.json({
      capas: countCapasByStatus(capas),
      documents: { to_review: documentsToReview },
      trainings: { to_renew: trainingsToRenew },
    });
  }
);

export default router;
