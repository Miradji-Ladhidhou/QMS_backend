import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();

router.use(requireAuth);

// GET /api/workflows/:id — détail avec l'état de chaque approbateur
router.get('/:id', async (req, res) => {
  const { data: workflow, error } = await supabase
    .from('document_workflows')
    .select('*, document:documents(id, number, title, status, version)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !workflow) {
    return res.status(404).json({ error: 'Workflow introuvable.' });
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from('document_approvals')
    .select('id, approver_id, decision, comment, decided_at, approver:users(id, full_name)')
    .eq('workflow_id', workflow.id)
    .order('created_at', { ascending: true });

  if (approvalsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les approbations.' });
  }

  res.json({ ...workflow, approvals });
});

// POST /api/workflows/:id/decide — un approbateur soumet sa décision
router.post(
  '/:id/decide',
  [
    body('decision').isIn(['approved', 'rejected']).withMessage('Décision invalide.'),
    body('comment')
      .if(body('decision').equals('rejected'))
      .trim()
      .notEmpty()
      .withMessage('Un commentaire est requis en cas de rejet.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: workflow, error: workflowError } = await supabase
      .from('document_workflows')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (workflowError || !workflow) {
      return res.status(404).json({ error: 'Workflow introuvable.' });
    }

    if (workflow.status !== 'pending') {
      return res.status(409).json({ error: 'Ce workflow a déjà été finalisé.' });
    }

    if (!workflow.required_approvers.includes(req.user.id)) {
      return res.status(403).json({ error: "Vous ne faites pas partie des approbateurs de ce workflow." });
    }

    const { decision, comment } = req.body;

    const { data: approval, error: approvalError } = await supabase
      .from('document_approvals')
      .update({ decision, comment: comment || null, decided_at: new Date().toISOString() })
      .eq('workflow_id', workflow.id)
      .eq('approver_id', req.user.id)
      .select()
      .single();

    if (approvalError || !approval) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la décision." });
    }

    await logAudit({
      tenantId: req.tenantId,
      documentId: workflow.document_id,
      userId: req.user.id,
      action: decision === 'approved' ? 'approval_decided_approved' : 'approval_decided_rejected',
      details: { workflow_id: workflow.id, comment: comment || null },
    });

    const { data: allApprovals, error: allApprovalsError } = await supabase
      .from('document_approvals')
      .select('decision')
      .eq('workflow_id', workflow.id);

    if (allApprovalsError) {
      return res.status(500).json({ error: 'Erreur lors de la vérification des approbations.' });
    }

    const decidedCount = allApprovals.filter((item) => item.decision !== 'pending').length;
    let finalStatus = null;

    if (decision === 'rejected') {
      finalStatus = 'rejected';
    } else if (allApprovals.every((item) => item.decision === 'approved')) {
      finalStatus = 'approved';
    }

    if (finalStatus) {
      await supabase
        .from('document_workflows')
        .update({ status: finalStatus, current_step: decidedCount })
        .eq('id', workflow.id);

      if (finalStatus === 'approved') {
        await supabase.from('documents').update({ status: 'approved', approved_by: req.user.id }).eq('id', workflow.document_id);
      } else {
        await supabase.from('documents').update({ status: 'draft', approved_by: null }).eq('id', workflow.document_id);
      }
    } else {
      await supabase.from('document_workflows').update({ current_step: decidedCount }).eq('id', workflow.id);
    }

    res.json({ approval, workflow_status: finalStatus || workflow.status });
  }
);

export default router;
