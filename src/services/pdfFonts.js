import { createRequire } from 'module';

// Les 14 polices standard de pdfkit (Helvetica...) sont limitées à l'encodage WinAnsi
// (Windows-1252, 256 caractères) : tout caractère hors de cette plage — puces, guillemets et
// apostrophes typographiques, symboles ≥/≤... — ressort en mojibake plutôt qu'en glyphe de
// remplacement (bug réel constaté sur un export HACCP, voir haccpAuditPdf.js). DejaVu Sans
// (licence Bitstream Vera, libre y compris en usage commercial, via le paquet dejavu-fonts-ttf)
// couvre un jeu de caractères bien plus large — centralisé ici pour que TOUS les générateurs
// PDF de l'application en bénéficient, pas seulement celui qui a révélé le bug.
const require = createRequire(import.meta.url);
export const DEJAVU_SANS = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');

// Limite connue (documentée en détail dans haccpAuditPdf.js) : la ligature "fi" reste correcte
// à l'affichage/impression mais perd son "i" dans le texte extrait (recherche/copier-coller) —
// limitation de pdfkit 0.15 sur le ToUnicode des glyphes multi-points-de-code, non contrôlable
// via les features OpenType. Jugé mineur face au bug que cette police corrige.

// Enregistre et sélectionne DejaVu Sans comme police par défaut du document, et la réapplique à
// chaque nouvelle page — pdfkit ne le fait pas tout seul lors d'un saut de page automatique
// (overflow de texte), qui repasserait sinon silencieusement sur Helvetica dès la page 2.
// À appeler juste après `new PDFDocument(...)`, avant tout autre texte.
export function useUnicodeFont(doc) {
  doc.registerFont('Body', DEJAVU_SANS);
  doc.font('Body');
  doc.on('pageAdded', () => doc.font('Body'));
}
