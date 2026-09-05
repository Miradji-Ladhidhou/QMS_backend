import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que qqoqccpPdf.js/kpiReportPdf.js pour une identité visuelle cohérente entre
// tous les rapports PDF de l'application — dupliquées plutôt qu'importées, voir la note dans
// qqoqccpPdf.js sur l'absence de module de constantes partagé.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';
const ROW_ALT = '#f8fafc';

const PAGE_MARGIN = 50;
// A4 portrait par défaut ; on bascule en paysage (dimensions inversées) au-delà de
// LANDSCAPE_COLUMN_THRESHOLD colonnes — en portrait, la largeur de colonne moyenne descend sous
// ~60pt (illisible à 8pt de police) dès qu'on dépasse ce nombre. Calculées par appel (pas des
// constantes de module) puisque l'orientation dépend désormais du tableau à générer.
const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const LANDSCAPE_COLUMN_THRESHOLD = 8;
const TABLE_HEADER_HEIGHT = 20;
const CELL_PADDING = 4;
const CELL_FONT_SIZE = 8;
// Plafond de hauteur de cellule (~3 lignes à CELL_FONT_SIZE + le padding vertical) : au-delà,
// le texte est tronqué avec "…" (voir drawCellText) plutôt que de gonfler toute la ligne — une
// seule valeur exceptionnellement longue ne doit jamais déséquilibrer tout le tableau.
const MAX_CELL_HEIGHT = 40;
const MIN_COLUMN_WIDTH = 40;
// Échantillon de lignes utilisé pour estimer la largeur "naturelle" d'une colonne sans
// mesurer les 5000 lignes possibles (voir routes/reports.js) à chaque génération.
const WIDTH_SAMPLE_SIZE = 200;

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

function cellDisplayValue(row, key) {
  const value = row[key];
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js et le même try/catch
// dans qqoqccpPdf.js/kpiReportPdf.js (un format que pdfkit ne sait pas décoder ne doit jamais
// faire échouer toute la génération du rapport).
function drawPageHeader(doc, layout, tenantName, title, generatedBy) {
  doc.rect(0, 0, layout.width, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text(title, PAGE_MARGIN, 26, { width: layout.contentWidth - 72 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  const generatedLine = generatedBy
    ? `Généré par ${generatedBy} le ${formatDateTime(new Date().toISOString())}`
    : `Généré le ${formatDateTime(new Date().toISOString())}`;
  doc.text(generatedLine, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;
}

function drawLogo(doc, layout, tenantLogo) {
  if (!tenantLogo) return;
  try {
    doc.image(tenantLogo, layout.width - PAGE_MARGIN - 62, 12, { fit: [62, 62], align: 'right', valign: 'center' });
  } catch {
    // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
  }
}

// widths : fraction de contentWidth (0-1) par colonne, fournie pour toutes ou aucune. Dans ce
// dernier cas, largeur "naturelle" par colonne = le plus large entre le libellé et un
// échantillon des valeurs réellement présentes (mesuré avec la police du tableau, pas celle du
// texte courant) — puis mise à l'échelle pour remplir exactement contentWidth, avec un plancher
// pour éviter qu'une colonne à valeurs courtes ne devienne illisiblement étroite.
function resolveColumnWidths(doc, columns, rows, contentWidth) {
  const allHaveWidth = columns.every((col) => typeof col.width === 'number');

  let naturalWidths;
  if (allHaveWidth) {
    naturalWidths = columns.map((col) => col.width * contentWidth);
  } else {
    doc.fontSize(CELL_FONT_SIZE);
    const sample = rows.slice(0, WIDTH_SAMPLE_SIZE);
    naturalWidths = columns.map((col) => {
      const headerWidth = doc.widthOfString(col.label, { width: contentWidth }) + 20; // marge pour le gras visuel de l'en-tête
      const maxValueWidth = sample.reduce((max, row) => {
        const width = doc.widthOfString(cellDisplayValue(row, col.key));
        return Math.max(max, width);
      }, 0);
      return Math.max(MIN_COLUMN_WIDTH, headerWidth, maxValueWidth + CELL_PADDING * 2);
    });
    const totalNatural = naturalWidths.reduce((sum, w) => sum + w, 0);
    const scale = totalNatural > 0 ? contentWidth / totalNatural : 1;
    naturalWidths = naturalWidths.map((w) => Math.max(MIN_COLUMN_WIDTH, w * scale));
    // La mise à l'échelle avec plancher peut légèrement dépasser/sous-remplir contentWidth
    // (colonnes déjà au plancher qui ne se compriment plus) : on répartit l'écart final au
    // prorata pour que la dernière colonne ne déborde jamais du cadre du tableau.
    const scaledTotal = naturalWidths.reduce((sum, w) => sum + w, 0);
    const drift = contentWidth - scaledTotal;
    if (drift !== 0) naturalWidths[naturalWidths.length - 1] += drift;
  }

  const positions = [];
  let x = PAGE_MARGIN;
  naturalWidths.forEach((w) => {
    positions.push(x);
    x += w;
  });
  return { widths: naturalWidths, positions };
}

// Dessine une cellule avec troncature "…" si le contenu dépasse MAX_CELL_HEIGHT — évite qu'une
// valeur de texte exceptionnellement longue ne fasse déborder la ligne au-delà de ce qui a été
// réservé pour elle (voir le plafond appliqué à rowHeight dans buildListReportPdf).
function drawCellText(doc, text, x, y, width) {
  doc.text(text, x, y, { width, height: MAX_CELL_HEIGHT - CELL_PADDING * 2, ellipsis: true });
}

// Générateur de PDF générique pour toutes les pages "liste" de l'application (tableau de
// colonnes/lignes déjà formatées côté appelant) — un seul module réutilisé par toutes les
// routes d'export plutôt qu'un service dédié par outil, voir routes/reports.js.
export function buildListReportPdf({ tenantName, tenantLogo, title, subtitle, generatedBy, columns, rows }) {
  return new Promise((resolve, reject) => {
    const size = columns.length > LANDSCAPE_COLUMN_THRESHOLD ? A4_LANDSCAPE : A4_PORTRAIT;
    const layout = { width: size.width, height: size.height, contentWidth: size.width - PAGE_MARGIN * 2 };

    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: [size.width, size.height], bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    doc.on('pageAdded', () => {
      drawPageHeader(doc, layout, tenantName, title, generatedBy);
      drawLogo(doc, layout, tenantLogo);
    });

    drawPageHeader(doc, layout, tenantName, title, generatedBy);
    drawLogo(doc, layout, tenantLogo);

    if (subtitle) {
      doc.fontSize(9).fillColor(MUTED).text(subtitle, PAGE_MARGIN, doc.y, { width: layout.contentWidth });
      doc.moveDown(0.6);
    }

    const { widths, positions } = resolveColumnWidths(doc, columns, rows, layout.contentWidth);

    function drawTableHeader() {
      const headerY = doc.y;
      doc.rect(PAGE_MARGIN, headerY, layout.contentWidth, TABLE_HEADER_HEIGHT).fill(NAVY);
      doc.fontSize(CELL_FONT_SIZE).fillColor('#ffffff');
      columns.forEach((col, i) => {
        doc.text(col.label, positions[i] + CELL_PADDING, headerY + 6, { width: widths[i] - CELL_PADDING * 2 });
      });
      doc.y = headerY + TABLE_HEADER_HEIGHT;
      doc.fillColor(INK);
    }

    drawTableHeader();

    if (rows.length === 0) {
      doc.moveDown(0.6);
      doc.fontSize(10).fillColor(MUTED).text('Aucun enregistrement à afficher.', PAGE_MARGIN, doc.y, { width: layout.contentWidth });
    }

    rows.forEach((row, rowIndex) => {
      doc.fontSize(CELL_FONT_SIZE);
      const cellHeights = columns.map((col, i) =>
        Math.min(MAX_CELL_HEIGHT, doc.heightOfString(cellDisplayValue(row, col.key), { width: widths[i] - CELL_PADDING * 2 }))
      );
      const rowHeight = Math.max(16, ...cellHeights.map((h) => h + CELL_PADDING * 2));

      // Un saut de page redessine l'en-tête ET la ligne d'entêtes de colonnes, pour qu'aucune
      // page continuée ne se retrouve avec un tableau sans repère de colonnes.
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + rowHeight > bottom) {
        doc.addPage();
        drawTableHeader();
      }

      const rowY = doc.y;
      if (rowIndex % 2 === 1) {
        doc.rect(PAGE_MARGIN, rowY, layout.contentWidth, rowHeight).fill(ROW_ALT);
      }
      doc.fillColor(INK).fontSize(CELL_FONT_SIZE);
      columns.forEach((col, i) => {
        drawCellText(doc, cellDisplayValue(row, col.key), positions[i] + CELL_PADDING, rowY + CELL_PADDING, widths[i] - CELL_PADDING * 2);
      });
      doc.y = rowY + rowHeight;
    });

    // Bug réel corrigé : écrire ce pied de page tout près du bas déclenchait le saut de page
    // automatique de pdfkit (.text() ajoute une page si le texte ne "rentre" pas au-dessus de
    // page.margins.bottom), créant une page fantôme en plus rien que pour ce texte — visible
    // pour un document d'une seule page qui se retrouvait avec une 2e page vide affichant
    // "Page 1 / 1". Neutraliser la marge basse le temps de cet appel évite le déclenchement.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
        width: layout.contentWidth,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
