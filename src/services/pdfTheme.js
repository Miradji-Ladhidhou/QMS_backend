// Palette et en-tête partagés par tous les documents PDF générés par l'application
// (listReportPdf.js, qqoqccpPdf.js, capaPdf.js, procedurePdf.js, certificatePdf.js,
// haccpAuditPdf.js, qualityPolicyPdf.js, skillMatrixPdf.js, attendanceSheetPdf.js,
// trainingCertificatePdf.js — voir aussi listReportWord.js pour l'équivalent Word).
//
// Avant ce module, chaque service dupliquait son propre bleu marine fixe (#1F3864) en bandeau
// plein d'en-tête, avec le logo du tenant réduit à 54-62pt dans un coin — repéré comme un vrai
// défaut de design (demande utilisateur) : ces documents (CAPA, audit, politique qualité,
// certificat de formation...) représentent l'entreprise du TENANT face à son propre auditeur
// ou employé, pas notre marque SaaS. Imposer notre bleu dessus, avec leur logo en petit badge,
// donnait à chaque export l'air d'un template générique plutôt que d'un document officiel de
// l'entreprise qui l'émet.
//
// Nouveau parti pris : lettre à en-tête neutre — fond blanc, aucune couleur imposée, logo
// agrandi et mis en avant, filet fin gris sous l'en-tête plutôt qu'un bandeau de couleur.
// Centralisé ici (au lieu d'être re-dupliqué comme avant) : les commentaires historiques de
// chaque service notaient déjà l'absence de module de constantes partagé comme un manque.

export const INK = '#1e293b'; // texte principal (titres, contenu)
export const MUTED = '#64748b'; // texte secondaire (sous-titre, généré par/le, pagination)
export const RULE = '#cbd5e1'; // filets et séparateurs
export const RULE_LIGHT = '#e2e8f0'; // grille de tableau, bordures discrètes
export const HEADER_FILL = '#f1f5f9'; // fond des en-têtes de tableau (gris très clair, remplace l'ancien bandeau NAVY plein)
export const ROW_ALT = '#f8fafc'; // zébrage léger des lignes de tableau

// Élément dominant de l'en-tête (agrandi depuis 54-62pt) : c'est la seule partie du document
// réellement spécifique au tenant, elle doit se voir avant tout le reste.
const LOGO_SIZE = 100;
const LOGO_GAP = 18;
const HEADER_TOP_PADDING = 34;
const HEADER_BOTTOM_PADDING = 26;

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// Dessine l'en-tête "lettre" (logo à gauche, nom d'entreprise + titre du document à droite,
// filet fin en bas) et positionne doc.y juste après. Hauteur calculée depuis le texte réel
// (titre parfois long/multi-lignes, ex. numéro + titre d'une CAPA) plutôt que fixée, pour ne
// jamais chevaucher le contenu qui suit — même principe que l'ancien bandeau à hauteur
// variable de capaPdf.js/procedurePdf.js, désormais partagé par tous.
//
// { pageWidth, marginX, tenantName, tenantLogo, title, subtitle, generatedBy } — subtitle
// optionnel (texte libre affiché sous le nom d'entreprise, ex. le sous-titre d'une liste
// filtrée) ; generatedBy optionnel (sinon seule la date figure sur la ligne "Généré le").
// Retourne la hauteur totale de l'en-tête (utile à drawLogo si un appelant doit la recaler,
// ex. lors d'un redessin sur une nouvelle page).
export function drawLetterheadHeader(doc, { pageWidth, marginX, tenantName, tenantLogo, title, subtitle, generatedBy }) {
  const textX = marginX + LOGO_SIZE + LOGO_GAP;
  const textWidth = pageWidth - marginX - textX;

  doc.font('Body-Bold').fontSize(14);
  const nameHeight = doc.heightOfString(tenantName || 'Entreprise', { width: textWidth });
  doc.font('Body').fontSize(12);
  const titleHeight = doc.heightOfString(title, { width: textWidth });

  const metaLine = generatedBy ? `Généré par ${generatedBy} le ${formatDateTime(new Date().toISOString())}` : `Généré le ${formatDateTime(new Date().toISOString())}`;
  doc.fontSize(8);
  const subtitleHeight = subtitle ? doc.heightOfString(subtitle, { width: textWidth }) + 4 : 0;

  const textBlockHeight = nameHeight + 4 + titleHeight + subtitleHeight + 4 + 10; // + interlignes + ligne méta
  const headerHeight = Math.max(LOGO_SIZE + HEADER_TOP_PADDING, textBlockHeight + HEADER_TOP_PADDING);

  let y = HEADER_TOP_PADDING;
  doc.font('Body-Bold').fontSize(14).fillColor(INK).text(tenantName || 'Entreprise', textX, y, { width: textWidth });
  y += nameHeight + 4;
  doc.font('Body').fontSize(12).fillColor(INK).text(title, textX, y, { width: textWidth });
  y += titleHeight + 4;
  if (subtitle) {
    doc.fontSize(8).fillColor(MUTED).text(subtitle, textX, y, { width: textWidth });
    y += subtitleHeight;
  }
  doc.fontSize(8).fillColor(MUTED).text(metaLine, textX, y, { width: textWidth });

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, marginX, (headerHeight - LOGO_SIZE) / 2, { fit: [LOGO_SIZE, LOGO_SIZE], align: 'left', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }

  doc.moveTo(marginX, headerHeight).lineTo(pageWidth - marginX, headerHeight).lineWidth(1).strokeColor(RULE).stroke();

  doc.fillColor(INK);
  doc.y = headerHeight + HEADER_BOTTOM_PADDING;

  return headerHeight;
}
