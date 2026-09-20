import { ImageRun } from 'docx';
import imageSize from 'image-size';

// Logo agrandi mais borné : une hauteur fixe, jamais de déformation (largeur calculée depuis
// les dimensions réelles de l'image, voir logoImageRun ci-dessous).
export const LOGO_MAX_HEIGHT_PT = 40;

// Lit les dimensions réelles du logo (PNG/JPEG/WEBP/GIF — seuls formats acceptés à l'upload,
// voir routes/tenant.js#ALLOWED_LOGO_TYPES) pour calculer une largeur proportionnelle à une
// hauteur fixe, sans jamais déformer l'image (docx#ImageRun exige des dimensions explicites,
// il ne les déduit pas seul du buffer). Partagé par tous les exports Word (procedureWord.js,
// listReportWord.js) : le logo est placé dans l'en-tête de section, donc répété sur chaque page.
export function logoImageRun(tenantLogo) {
  if (!tenantLogo) return null;
  try {
    const { width, height, type } = imageSize(tenantLogo);
    if (!width || !height) return null;
    const heightPt = LOGO_MAX_HEIGHT_PT;
    const widthPt = Math.round((width / height) * heightPt);
    const docxType = type === 'jpg' ? 'jpeg' : type; // ImageRun attend 'jpeg', image-size renvoie 'jpg'.
    return new ImageRun({ type: docxType, data: tenantLogo, transformation: { width: widthPt, height: heightPt } });
  } catch {
    // Format non décodable : en-tête sans logo, pas d'erreur (même principe que
    // services/pdfTheme.js#drawLetterheadHeader pour le PDF).
    return null;
  }
}

// Image PNG (data URL, ex. une signature manuscrite validée par services/signatureImage.js) en
// ImageRun, ramenée dans une boîte maxWidth × maxHeight (en points) sans jamais la déformer ni
// l'agrandir. Retourne null si l'image est absente ou illisible : le document se génère alors sans
// elle plutôt que d'échouer.
export function dataUrlImageRun(dataUrl, { maxWidth, maxHeight }) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  try {
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const { width, height } = imageSize(buffer);
    if (!width || !height) return null;
    const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
    return new ImageRun({
      type: 'png',
      data: buffer,
      transformation: { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) },
    });
  } catch {
    return null;
  }
}
