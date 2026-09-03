import { createHmac } from 'crypto';

// Ticket signé, à durée de vie courte, pour GET /api/documents/drive-file : cette route est
// atteinte par une navigation navigateur classique (window.open depuis le frontend), qui ne
// porte pas notre en-tête Authorization — elle ne peut donc pas passer par requireAuth comme
// le reste des routeurs. Le ticket transporte directement le fileId Drive déjà résolu (pas un
// id de document/version), et jamais le tenant/l'appelant : n'importe quel module qui a déjà
// vérifié le droit de consultation de SON fichier peut émettre un ticket pour le faire streamer
// par le même proxy, sans dupliquer cette logique de signature/vérification (voir
// routes/documents.js#verifyDownloadTicket, resté dans ce fichier puisque c'est lui qui sert la
// route ; routes/procedures.js n'a besoin que de signer, jamais de vérifier).
const DOWNLOAD_TICKET_TTL_MS = 5 * 60 * 1000;

export function getTicketSecret() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    const err = new Error('ENCRYPTION_KEY est manquant.');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

// Nom de fichier encodé en base64url : évite qu'un ':' dans un nom de fichier réel ne casse le
// split fait par verifyDownloadTicket.
export function signDownloadTicket(tenantId, driveFileId, fileName, disposition = 'attachment') {
  const expiresAt = Date.now() + DOWNLOAD_TICKET_TTL_MS;
  const fileNameB64 = Buffer.from(fileName || '', 'utf8').toString('base64url');
  const payload = `${tenantId}:${driveFileId}:${fileNameB64}:${expiresAt}:${disposition}`;
  const signature = createHmac('sha256', getTicketSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}
