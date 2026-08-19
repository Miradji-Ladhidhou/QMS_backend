import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parseServiceIdsParam, fetchServiceUserIds, resolveServiceScope } from '../services/serviceScope.js';
import {
  fetchCapaItems,
  fetchDocumentItems,
  fetchTrainingItems,
  fetchTaskItems,
  fetchAuditItems,
  fetchComplaintItems,
} from '../services/planningItems.js';

const router = Router();
router.use(requireAuth);

// GET /api/planning — agrège CAPA/documents/formations/tâches/audits/réclamations en une
// liste chronologique unique, avec le même filtrage par rôle et par service que
// /api/dashboard/stats :
// - admin : tout le tenant par défaut, filtrable ponctuellement via ?service_id=
// - manager : auto-scopé sur ses services par défaut, élargissement ponctuel possible
// - member : uniquement ses propres éléments (CAPA/réclamations assignées, ses formations,
//   ses tâches, les audits qu'il mène) — jamais de documents (pas de porteur individuel) ni
//   de vue tenant/service
router.get('/', async (req, res) => {
  const requestedServiceIds = parseServiceIdsParam(req.query.service_id);
  if (!requestedServiceIds) {
    return res.status(400).json({ error: 'Service invalide.' });
  }

  let items;

  if (req.userRole === 'member') {
    const [capaItems, trainingItems, taskItems, auditItems, complaintItems] = await Promise.all([
      fetchCapaItems(req.tenantId, { assignedTo: req.user.id }),
      fetchTrainingItems(req.tenantId, { userId: req.user.id }),
      fetchTaskItems(req.tenantId, { personalUserId: req.user.id }),
      fetchAuditItems(req.tenantId, { leadAuditorId: req.user.id }),
      fetchComplaintItems(req.tenantId, { assignedTo: req.user.id }),
    ]);
    items = [...capaItems, ...trainingItems, ...taskItems, ...auditItems, ...complaintItems];
  } else {
    const serviceIds = await resolveServiceScope({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      requestedServiceIds,
    });

    const trainingUserIds = serviceIds ? await fetchServiceUserIds(req.tenantId, serviceIds) : null;

    const [capaItems, documentItems, trainingItems, taskItems, auditItems, complaintItems] = await Promise.all([
      fetchCapaItems(req.tenantId, { serviceIds }),
      fetchDocumentItems(req.tenantId),
      fetchTrainingItems(req.tenantId, { userIds: trainingUserIds }),
      fetchTaskItems(req.tenantId, {}),
      fetchAuditItems(req.tenantId, { serviceIds }),
      fetchComplaintItems(req.tenantId, { serviceIds }),
    ]);
    items = [...capaItems, ...documentItems, ...trainingItems, ...taskItems, ...auditItems, ...complaintItems];
  }

  items.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));

  res.json({ items });
});

export default router;
