import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildListReportPdf } from '../services/listReportPdf.js';

const router = Router();

router.use(requireAuth);

// POST /api/reports/table-pdf — export PDF générique partagé par toutes les pages "liste" de
// l'application (audits, réclamations, risques, fournisseurs, revues, CAPA, documents,
// formations, planning...). Même principe que POST /api/ai/capa-suggestion : cette route ne
// lit aucune table métier — les lignes viennent déjà des routes GET dédiées, déjà filtrées
// par rôle/tenant côté serveur avant d'arriver dans le state React. Le frontend envoie
// exactement ce qu'il affiche à l'écran (donc respecte les filtres actifs de la page), et
// cette route se contente de le mettre en forme avec l'en-tête logo/entreprise commun à tous
// les rapports PDF de l'application (voir services/listReportPdf.js).
router.post(
  '/table-pdf',
  [
    body('title').trim().isLength({ min: 1, max: 200 }).withMessage('Titre requis.'),
    body('subtitle').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('generatedBy').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    body('columns').isArray({ min: 1, max: 20 }).withMessage('Colonnes invalides.'),
    body('columns.*.key').trim().isLength({ min: 1 }),
    body('columns.*.label').trim().isLength({ min: 1 }),
    body('rows').isArray({ max: 5000 }).withMessage('Trop de lignes pour un export PDF.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, subtitle, generatedBy, columns, rows } = req.body;

    try {
      const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
      const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
      const pdfBuffer = await buildListReportPdf({
        tenantName: tenant?.name,
        tenantLogo,
        title,
        subtitle,
        generatedBy,
        columns,
        rows,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="rapport.pdf"');
      res.send(pdfBuffer);
    } catch {
      res.status(500).json({ error: 'Impossible de générer le PDF.' });
    }
  }
);

export default router;
