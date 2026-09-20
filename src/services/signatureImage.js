import imageSize from 'image-size';

// Signatures manuscrites (salarié en fin de QCM, formateur sur la fiche de formation) : toujours une
// image PNG envoyée en data URL par le navigateur. Rien n'est stocké sans avoir été vérifié ici —
// un champ texte libre écrit tel quel en base puis intégré à un document Word ne doit jamais
// pouvoir contenir autre chose qu'une petite image.
const PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 300 * 1024;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 800;

// Retourne { dataUrl, buffer } ou { error }. Le texte d'erreur est destiné à l'utilisateur.
export function validateSignatureImage(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
    return { error: 'Signature invalide : une image PNG est attendue.' };
  }

  const base64 = value.slice(PREFIX.length);
  // Le décodage base64 de Node ignore silencieusement les caractères invalides : on vérifie
  // l'alphabet avant, sinon n'importe quel texte passerait pour une image « vide ».
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: 'Signature invalide : image illisible.' };

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_BYTES) return { error: 'Signature trop volumineuse.' };
  if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { error: 'Signature invalide : ce n\'est pas une image PNG.' };
  }

  let size;
  try {
    size = imageSize(buffer);
  } catch {
    return { error: 'Signature invalide : image illisible.' };
  }
  if (!size.width || !size.height || size.type !== 'png') return { error: 'Signature invalide : image illisible.' };
  if (size.width > MAX_WIDTH || size.height > MAX_HEIGHT) return { error: 'Signature trop grande.' };

  return { dataUrl: value, buffer };
}
