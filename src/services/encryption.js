import crypto from 'crypto';

// AES-256-GCM natif Node — pas de dépendance externe pour un besoin aussi ciblé (chiffrer
// deux champs texte avant stockage). GCM plutôt que CBC : authentifié, donc toute altération
// du texte chiffré (base compromise, erreur de copie) est détectée au déchiffrement au lieu de
// produire silencieusement du texte corrompu.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // taille recommandée pour GCM (96 bits)

function getKey() {
  const keyBase64 = process.env.ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new Error('ENCRYPTION_KEY est manquant.');
  }
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64.');
  }
  return key;
}

// Renvoie "iv:authTag:ciphertext" (chaque partie en base64) : un seul champ text à stocker,
// tout ce qu'il faut pour déchiffrer est contenu dans la valeur elle-même.
export function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(payload) {
  const key = getKey();
  const [ivB64, authTagB64, dataB64] = String(payload || '').split(':');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('Valeur chiffrée invalide ou corrompue.');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
