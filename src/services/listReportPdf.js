import PDFDocument from 'pdfkit';

// Mêmes teintes que qqoqccpPdf.js/kpiReportPdf.js pour une identité visuelle cohérente entre
// tous les rapports PDF de l'application — dupliquées plutôt qu'importées, voir la note dans
// qqoqccpPdf.js sur l'absence de module de constantes partagé.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';
const ROW_ALT = '#f8fafc';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const TABLE_HEADER_HEIGHT = 20;
const CELL_PADDING = 4;

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js et le même try/catch
// dans qqoqccpPdf.js/kpiReportPdf.js (un format que pdfkit ne sait pas décoder ne doit jamais
// faire échouer toute la génération du rapport).
function drawPageHeader(doc, tenantName, title) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text(title, PAGE_MARGIN, 26, { width: CONTENT_WIDTH - 60 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;
}

function drawLogo(doc, tenantLogo) {
  if (!tenantLogo) return;
  try {
    doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 50, 18, { fit: [50, 50], align: 'right', valign: 'center' });
  } catch {
    // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
  }
}

// widths : fraction de CONTENT_WIDTH (0-1) par colonne, fournie pour toutes ou aucune — dans
// ce dernier cas la largeur est répartie également, ce qui suffit pour la plupart des listes.
function resolveColumnWidths(columns) {
  const allHaveWidth = columns.every((col) => typeof col.width === 'number');
  const widths = allHaveWidth ? columns.map((col) => col.width * CONTENT_WIDTH) : columns.map(() => CONTENT_WIDTH / columns.length);
  const positions = [];
  let x = PAGE_MARGIN;
  widths.forEach((w) => {
    positions.push(x);
    x += w;
  });
  return { widths, positions };
}

// Générateur de PDF générique pour toutes les pages "liste" de l'application (tableau de
// colonnes/lignes déjà formatées côté appelant) — un seul module réutilisé par toutes les
// routes d'export plutôt qu'un service dédié par outil, voir routes/reports.js.
export function buildListReportPdf({ tenantName, tenantLogo, title, subtitle, columns, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.on('pageAdded', () => {
      drawPageHeader(doc, tenantName, title);
      drawLogo(doc, tenantLogo);
    });

    drawPageHeader(doc, tenantName, title);
    drawLogo(doc, tenantLogo);

    if (subtitle) {
      doc.fontSize(9).fillColor(MUTED).text(subtitle, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.6);
    }

    const { widths, positions } = resolveColumnWidths(columns);

    function drawTableHeader() {
      const headerY = doc.y;
      doc.rect(PAGE_MARGIN, headerY, CONTENT_WIDTH, TABLE_HEADER_HEIGHT).fill(NAVY);
      doc.fontSize(8).fillColor('#ffffff');
      columns.forEach((col, i) => {
        doc.text(col.label, positions[i] + CELL_PADDING, headerY + 6, { width: widths[i] - CELL_PADDING * 2 });
      });
      doc.y = headerY + TABLE_HEADER_HEIGHT;
      doc.fillColor(INK);
    }

    drawTableHeader();

    if (rows.length === 0) {
      doc.moveDown(0.6);
      doc.fontSize(10).fillColor(MUTED).text('Aucun enregistrement à afficher.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    }

    rows.forEach((row, rowIndex) => {
      doc.fontSize(8);
      const cellHeights = columns.map((col, i) =>
        doc.heightOfString(row[col.key] === null || row[col.key] === undefined || row[col.key] === '' ? '—' : String(row[col.key]), {
          width: widths[i] - CELL_PADDING * 2,
        })
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
        doc.rect(PAGE_MARGIN, rowY, CONTENT_WIDTH, rowHeight).fill(ROW_ALT);
      }
      doc.fillColor(INK).fontSize(8);
      columns.forEach((col, i) => {
        const value = row[col.key];
        doc.text(value === null || value === undefined || value === '' ? '—' : String(value), positions[i] + CELL_PADDING, rowY + CELL_PADDING, {
          width: widths[i] - CELL_PADDING * 2,
        });
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
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
