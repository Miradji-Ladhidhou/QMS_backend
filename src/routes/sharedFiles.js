import { Router } from 'express';
import { decodeFileTicket, authorizedFile, streamProtectedFile } from '../services/sharedFiles.js';

const router = Router();
router.get('/:ticket', async (req, res) => {
  const ticket = decodeFileTicket(req.params.ticket);
  if (!ticket) return res.status(403).json({ error: 'Lien de fichier invalide ou expiré.' });
  const file = await authorizedFile(ticket);
  if (!file?.path) return res.status(403).json({ error: 'Fichier indisponible ou téléchargement interdit.' });
  await streamProtectedFile(res, ticket.tenantId, file, ticket.disposition);
});
export default router;
