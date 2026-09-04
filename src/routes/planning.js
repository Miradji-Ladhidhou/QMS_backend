import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { parseServiceIdsParam, fetchServiceUserIds, resolveServiceScope } from '../services/serviceScope.js';
import {
  fetchCapaItems,
  fetchDocumentItems,
  fetchProcedureItems,
  fetchTrainingItems,
  fetchTaskItems,
  fetchAuditItems,
  fetchComplaintItems,
  fetchRiskItems,
  fetchSupplierItems,
} from '../services/planningItems.js';

const router = Router();
router.use(requireAuth);
router.use(requireMenuVisible('planning'));

// GET /api/planning — agrège CAPA/documents/procédures/formations/tâches/audits/
// réclamations/risques en une liste chronologique unique, avec le même filtrage par rôle et
// par service que /api/dashboard/stats :
// - admin : tout le tenant par défaut, filtrable ponctuellement via ?service_id=
// - manager : auto-scopé sur ses services par défaut, élargissement ponctuel possible
// - member : uniquement ses propres éléments (CAPA/réclamations assignées, ses formations,
//   ses tâches, les audits qu'il mène, les risques dont il est responsable) — jamais de
//   documents ni de procédures (pas de porteur individuel, voir schema.sql) ni de vue
//   tenant/service
router.get('/', async (req, res) => {
  const requestedServiceIds = parseServiceIdsParam(req.query.service_id);
  if (!requestedServiceIds) {
    return res.status(400).json({ error: 'Service invalide.' });
  }

  let items;

  if (req.userRole === 'member') {
    const [capaItems, trainingItems, taskItems, auditItems, complaintItems, riskItems] = await Promise.all([
      fetchCapaItems(req.tenantId, { assignedTo: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchTrainingItems(req.tenantId, { userId: req.user.id }),
      fetchTaskItems(req.tenantId, { personalUserId: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchAuditItems(req.tenantId, { leadAuditorId: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchComplaintItems(req.tenantId, { assignedTo: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchRiskItems(req.tenantId, { ownerId: req.user.id, userId: req.user.id, userRole: req.userRole }),
    ]);
    items = [...capaItems, ...trainingItems, ...taskItems, ...auditItems, ...complaintItems, ...riskItems];
  } else {
    const serviceIds = await resolveServiceScope({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      requestedServiceIds,
    });

    const trainingUserIds = serviceIds ? await fetchServiceUserIds(req.tenantId, serviceIds) : null;

    const [capaItems, documentItems, procedureItems, trainingItems, taskItems, auditItems, complaintItems, riskItems, supplierItems] =
      await Promise.all([
        fetchCapaItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
        fetchDocumentItems(req.tenantId),
        fetchProcedureItems(req.tenantId),
        fetchTrainingItems(req.tenantId, { userIds: trainingUserIds }),
        fetchTaskItems(req.tenantId, { userId: req.user.id, userRole: req.userRole }),
        fetchAuditItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
        fetchComplaintItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
        fetchRiskItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
        fetchSupplierItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
      ]);
    items = [
      ...capaItems,
      ...documentItems,
      ...procedureItems,
      ...trainingItems,
      ...taskItems,
      ...auditItems,
      ...complaintItems,
      ...riskItems,
      ...supplierItems,
    ];
  }

  items.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));

  res.json({ items });
});

export default router;
