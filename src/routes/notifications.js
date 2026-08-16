import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail } from '../services/email.js';
import { renderTemplate } from '../services/renderTemplate.js';

const router = Router();
const TEMPLATES = ['documentToReview', 'capaOverdue', 'trainingRenewal', 'approvalRequest'];

const SAMPLE_VARIABLES = {
  documentToReview: {
    userName: 'Alice Martin',
    documentNumber: 'QP-001',
    documentTitle: 'Procédure de test',
    reviewDate: '01/09/2026',
    documentUrl: `${process.env.FRONTEND_URL}/documents`,
  },
  capaOverdue: {
    userName: 'Alice Martin',
    capaNumber: 'CAPA-2026-001',
    capaTitle: 'Test de notification',
    dueDate: '01/08/2026',
    capaUrl: `${process.env.FRONTEND_URL}/capas`,
  },
  trainingRenewal: {
    userName: 'Alice Martin',
    trainingTitle: 'Sécurité incendie',
    dueDate: '15/09/2026',
    trainingUrl: `${process.env.FRONTEND_URL}/trainings`,
  },
  approvalRequest: {
    approverName: 'Alice Martin',
    requesterName: 'Bruno Petit',
    documentNumber: 'QP-002',
    documentTitle: 'Manuel qualité',
    documentUrl: `${process.env.FRONTEND_URL}/documents`,
  },
};

router.use(requireAuth);

// POST /api/notifications/test-email — vérifie que l'envoi fonctionne (développement uniquement)
router.post(
  '/test-email',
  [
    body('to').isEmail().withMessage('Adresse email invalide.'),
    body('template').optional({ values: 'falsy' }).isIn(TEMPLATES).withMessage('Template inconnu.'),
  ],
  async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Cette route est réservée au développement.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { to, template = 'documentToReview' } = req.body;

    try {
      const html = renderTemplate(template, SAMPLE_VARIABLES[template]);
      const result = await sendEmail(to, `[Test QMS SaaS] ${template}`, html);
      res.json({ sent: true, template, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default router;
