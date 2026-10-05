import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';
import { logSuperAdminAction } from '../services/superAdminAudit.js';
import { readResourceCatalog, validateResourceGroups, writeResourceCatalog } from '../services/moduleResources.js';

const router = Router();
export const adminResourcesRouter = Router();

async function readCatalog(req, res) {
  res.json(await readResourceCatalog(supabase));
}

router.get('/', requireAuth, readCatalog);
adminResourcesRouter.get('/', readCatalog);
adminResourcesRouter.put('/', async (req, res) => {
  const validation = validateResourceGroups(req.body.groups);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const version = req.body.updated_at;
  if (version !== null && (typeof version !== 'string' || !Number.isFinite(Date.parse(version)))) {
    return res.status(400).json({ error: 'Version du catalogue invalide. Rechargez les liens utiles.' });
  }
  const { data, error } = await writeResourceCatalog(supabase, {
    groups: validation.groups, updatedAt: version, actorId: req.user.id,
  });
  if (error?.code === '23505' || (!error && !data)) {
    return res.status(409).json({ error: 'Le catalogue a été modifié par un autre administrateur. Rechargez-le avant de réessayer.' });
  }
  if (error) {
    console.error('[useful-links] publication impossible :', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer les liens utiles.' });
  }
  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'useful_links_updated',
    targetType: 'platform',
    details: { link_count: validation.groups.reduce((total, group) => total + group.resources.length, 0) },
  });
  res.json({ groups: validation.groups, updated_at: data.updated_at });
});

export default router;
