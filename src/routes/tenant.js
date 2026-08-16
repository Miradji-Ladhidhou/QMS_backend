import { Router } from 'express';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const LOGO_BUCKET = 'tenant-logos';

router.use(requireAuth);

// GET /api/tenant — informations de l'entreprise du tenant courant
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, logo_url')
    .eq('id', req.tenantId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Entreprise introuvable.' });
  }

  res.json(data);
});

// PATCH /api/tenant — met à jour le nom de l'entreprise (admin uniquement)
router.patch(
  '/',
  requireRole('owner', 'admin'),
  [body('name').trim().notEmpty().withMessage("Le nom de l'entreprise est requis.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({ name: req.body.name })
      .eq('id', req.tenantId)
      .select('id, name, slug, plan, logo_url')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    res.json(data);
  }
);

// POST /api/tenant/logo — upload du logo vers Supabase Storage (admin uniquement)
router.post('/logo', requireRole('owner', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier est requis.' });
  }

  const logoPath = `${req.tenantId}/logo-${Date.now()}-${req.file.originalname}`;

  const { error: uploadError } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(logoPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (uploadError) {
    return res.status(500).json({ error: "Échec de l'upload du logo." });
  }

  const { data, error } = await supabase
    .from('tenants')
    .update({ logo_url: logoPath })
    .eq('id', req.tenantId)
    .select('id, name, slug, plan, logo_url')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du logo.' });
  }

  res.json(data);
});

export default router;
