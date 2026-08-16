// Supabase Storage rejette certaines cles contenant des caracteres non-ASCII (ex: accents
// decomposes en NFD) avec une erreur "Invalid key" - frequent avec des noms de fichiers
// francais ("procedure ete.txt"). On ne sanitize que la cle de stockage ; file_name garde
// le nom original pour l'affichage et le telechargement.
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;
const UNSAFE_CHARS = /[^a-zA-Z0-9._-]+/g;

export function sanitizeFileName(name) {
  const normalized = name.normalize('NFD').replace(COMBINING_DIACRITICS, '').replace(UNSAFE_CHARS, '_');

  return normalized.replace(/^_+|_+$/g, '') || 'fichier';
}
