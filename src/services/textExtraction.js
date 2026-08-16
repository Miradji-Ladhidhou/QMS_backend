import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function getExtension(filename) {
  const match = /\.[^./\\]+$/.exec(filename || '');
  return match ? match[0].toLowerCase() : '';
}

// Extrait le texte d'un fichier uploadé (PDF, .docx, .txt/.md) pour la recherche plein texte.
// Ne bloque jamais l'upload : renvoie null si le type n'est pas supporté ou si l'extraction échoue.
export async function extractText(file) {
  if (!file) return null;

  const extension = getExtension(file.originalname);
  const mimetype = file.mimetype || '';

  try {
    if (mimetype === 'application/pdf' || extension === '.pdf') {
      const result = await pdfParse(file.buffer);
      return result.text?.trim() || null;
    }

    if (mimetype === DOCX_MIME || extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value?.trim() || null;
    }

    if (PLAIN_TEXT_EXTENSIONS.has(extension) || mimetype.startsWith('text/')) {
      return file.buffer.toString('utf-8').trim() || null;
    }

    return null;
  } catch (error) {
    console.error(`Échec de l'extraction du texte pour "${file.originalname}" :`, error.message);
    return null;
  }
}
