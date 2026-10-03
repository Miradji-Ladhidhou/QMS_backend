import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, HEADER_FILL } from './pdfTheme.js';

// RED/AMBER restent des couleurs sémantiques (obsolescence/retard), pas des couleurs de
// marque — volontairement non touchées par le passage à l'en-tête neutre.
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';
const AMBER = '#b45309';
const AMBER_LIGHT = '#fffbeb';

const PAGE_MARGIN = 36;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const VERSION_STATUS_LABELS = { draft: 'Brouillon', pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };
const DEFAULT_VISUAL_OPTIONS = { band: false, bulletStyle: 'round', calloutStyle: 'left-border' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

function formatDateTime(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleString('fr-FR') : '—';
}

function versionStatusLabel(procedure, version) {
  const status = VERSION_STATUS_LABELS[version.status] || version.status;
  return version.status === 'approved' && version.id === procedure.current_version_id ? `${status} — en vigueur` : status;
}

function drawProcedureControlHeader(doc, { procedure, version }) {
  const x = PAGE_MARGIN;
  const width = CONTENT_WIDTH;
  const leftWidth = width * 0.52;
  const rightX = x + leftWidth;
  const rightWidth = width - leftWidth;
  const rowHeights = [22, 68, 22];
  const top = PAGE_MARGIN;
  const rows = [
    [
      { text: 'PROCÉDURE DU SYSTÈME DE GESTION DE LA QUALITÉ', bold: true },
      { text: `DATE DE CRÉATION : ${formatDate(procedure.created_at)}` },
    ],
    [
      { text: `TITRE : ${procedure.title}`, bold: true, size: 10 },
      {
        text: `DOCUMENT N° : ${procedure.number}\nVERSION N° : ${version.version} (${versionStatusLabel(
          procedure,
          version
        )})\nDATE DE RÉVISION : ${formatDate(version.validated_at || version.created_at || procedure.updated_at)}\nPROCHAINE RÉVISION : ${formatDate(
          procedure.next_review_date
        )}`,
      },
    ],
    [
      { text: `RÉVISÉ PAR : ${version.author?.full_name || '—'}` },
      { text: `VALIDÉ PAR : ${version.validator?.full_name || '—'}` },
    ],
  ];

  let rowTop = top;
  rows.forEach((cells, rowIndex) => {
    const height = rowHeights[rowIndex];
    const cellBounds = [
      { x, width: leftWidth, ...cells[0] },
      { x: rightX, width: rightWidth, ...cells[1] },
    ];
    cellBounds.forEach((cell) => {
      doc.rect(cell.x, rowTop, cell.width, height).lineWidth(0.6).strokeColor(INK).stroke();
      doc
        .font(cell.bold ? 'Body-Bold' : 'Body')
        .fontSize(cell.size || 8)
        .fillColor(INK)
        .text(cell.text, cell.x + 6, rowTop + 5, {
          width: cell.width - 12,
          height: height - 8,
          lineGap: 1,
          ellipsis: true,
        });
    });
    rowTop += height;
  });

  doc.font('Body').fillColor(INK);
  doc.y = rowTop + 12;
}

function drawCompanyBand(doc, tenantName) {
  const top = PAGE_MARGIN;
  const height = 58;
  doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, height).fill('#E7E6E6');
  doc.font('Body').fontSize(18).fillColor(INK).text(tenantName || 'PROCÉDURE QUALITÉ', PAGE_MARGIN + 8, top + 18, {
    width: CONTENT_WIDTH - 16,
    align: 'center',
  });
  doc.y = top + height + 24;
}

function tableColumnFractions(headers, rows) {
  const count = Math.max(1, headers?.length || 0);
  if (count === 2) return [0.28, 0.72];
  if (count === 1) return [1];

  const weights = Array.from({ length: count }, (_, column) => {
    const maxLength = Math.max(
      String(headers?.[column] || '').length,
      ...(rows || []).map((row) => String(row?.[column] || '').length)
    );
    return Math.sqrt(Math.min(Math.max(maxLength, 12), 120));
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / totalWeight);
}

function sectionSubheadings(section) {
  return (section.blocks || []).flatMap((block) => {
    if (block.type === 'sous_titre' && block.text?.trim()) return [block.text.trim()];
    if (block.type !== 'paragraphe') return [];
    return String(block.text || '')
      .split('\n')
      .flatMap((line) => {
        const match = line.match(/^\s*\d+\.\d+\s+(.+)$/);
        return match ? [match[1].trim()] : [];
      });
  });
}

function tocPageLabel(entry) {
  if (!entry.startPage) return '';
  if (entry.endPage > entry.startPage) return `pages ${entry.startPage} à ${entry.endPage}`;
  return `page ${entry.startPage}`;
}

function drawTableOfContents(doc, entries, manualSommaire, accentColor, visualOptions) {
  doc.font('Body-Bold').fontSize(14).fillColor(INK).text('Sommaire', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body').moveDown(0.8);
  entries.forEach((entry) => {
    const nested = entry.nested;
    const left = PAGE_MARGIN + (nested ? 22 : 0);
    const labelWidth = CONTENT_WIDTH - (nested ? 22 : 0) - 86;
    const label = nested ? `•  ${entry.label}` : `${entry.number}.  ${entry.label}`;
    const y = doc.y;
    doc.font(nested ? 'Body' : 'Body-Bold').fontSize(nested ? 9 : 10).fillColor(INK);
    doc.text(label, left, y, { width: labelWidth, lineGap: 1 });
    if (!nested) {
      doc.font('Body').fontSize(9).fillColor(MUTED).text(tocPageLabel(entry), PAGE_MARGIN, y, {
        width: CONTENT_WIDTH,
        align: 'right',
      });
    }
    doc.moveDown(nested ? 0.25 : 0.45);
  });
  if (manualSommaire?.blocks?.length) {
    doc.moveDown(0.35);
    drawBlocks(
      doc,
      null,
      entries.length ? 'Notes du sommaire' : manualSommaire.label || 'Sommaire',
      manualSommaire.blocks,
      accentColor,
      visualOptions
    );
  }
}

function lightTint(color) {
  const hex = String(color || '').replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(hex)) return HEADER_FILL;
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return `#${channels.map((channel) => Math.round(channel + (255 - channel) * 0.88).toString(16).padStart(2, '0')).join('')}`;
}

// Même esprit que les encadrés "Important" d'un gabarit de procédure imprimé : un bandeau de
// couleur qui saute aux yeux, réservé à une information déjà réellement affichée à l'écran
// (bannière d'obsolescence sur ProcedureDetail.jsx, indicateur de retard sur Procedures.jsx) —
// jamais un contenu inventé pour l'occasion.
function drawImportantBox(doc, { color, background, label, text }) {
  doc.moveDown(0.3);
  const height = doc.heightOfString(text, { width: CONTENT_WIDTH - 16 }) + 30;

  // doc.rect() ne déclenche jamais de saut de page automatique (contrairement à .text()) : sans
  // cette vérification, un encadré démarré trop bas était coupé en plein milieu par le saut de
  // page déclenché par le .text() du label ci-dessous, et le `doc.y = boxTop + height + 10`
  // final restait calculé sur les coordonnées de l'ANCIENNE page — poussant le curseur bien au-
  // delà du bas de la nouvelle page et laissant une page quasi vide juste après (voir l'audit du
  // PDF généré pour une procédure au brouillon complet, où un callout par étape reproduisait ce
  // motif toutes les 2-3 pages).
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const boxTop = doc.y;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).fill(background);
  doc.font('Body-Bold').fontSize(9).fillColor(color).text(label, PAGE_MARGIN + 8, boxTop + 8, { width: CONTENT_WIDTH - 16 });
  doc.font('Body').fontSize(9).fillColor(INK).text(text, PAGE_MARGIN + 8, doc.y + 2, { width: CONTENT_WIDTH - 16 });
  doc.y = boxTop + height + 10;
}

// Miroir du PhotoPlaceholder de ProcedureContentView.jsx (écran) — jusqu'ici silencieusement
// absent du PDF, alors que ces emplacements réservés font partie du contenu réel de la
// procédure au même titre qu'un callout.
function drawPhotoPlaceholder(doc, caption) {
  doc.moveDown(0.2);
  const boxHeight = 24;
  if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const boxTop = doc.y;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, boxHeight).dash(3, { space: 2 }).strokeColor(MUTED).lineWidth(0.75).stroke();
  doc.undash();
  doc
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(`Emplacement réservé à une photo — ${caption}`, PAGE_MARGIN + 8, boxTop + 7, { width: CONTENT_WIDTH - 16 });
  doc.y = boxTop + boxHeight + 8;
}

// Tableau à colonnes/lignes libres (bloc "tableau" du modèle à blocs, voir
// services/procedureWord.js#tableBlockToDocxTable pour l'équivalent Word) — pdfkit n'a pas de
// primitive tableau native, donc quadrillage dessiné à la main avec les mêmes briques que
// drawImportantBox (doc.rect()). Chaque ligne vérifie l'espace restant AVANT de se dessiner
// (comme drawImportantBox) pour ne jamais couper une ligne en deux pages — pas d'équivalent
// strict du cantSplit du renderer Word, mais le même résultat pratique par construction.
function drawStructuredParagraph(doc, text, bulletStyle = DEFAULT_VISUAL_OPTIONS.bulletStyle) {
  const lines = String(text || '').split('\n');
  lines.forEach((line) => {
    const subsection = line.match(/^\s*(\d+\.\d+)\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const nested = /^\s{2,}/.test(line);
    if (subsection) {
      doc.font('Body-Bold').fontSize(10).fillColor(INK).text(`${subsection[1]}    ${subsection[2]}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
      doc.font('Body').moveDown(0.22);
      return;
    }
    if (bullet || ordered) {
      const marker = ordered ? `${ordered[1]}.` : bulletStyle === 'round' ? '•' : '–';
      const value = ordered ? ordered[2] : bullet[1];
      if (!value.trim()) return;
      const left = PAGE_MARGIN + (nested ? 28 : 14);
      const valueWidth = CONTENT_WIDTH - (left - PAGE_MARGIN) - 16;
      const valueHeight = doc.heightOfString(value.trim(), { width: valueWidth, lineGap: 2 });
      if (doc.y + valueHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
      const lineY = doc.y;
      doc.fontSize(10).fillColor(INK).text(marker, left, lineY, { width: 14 });
      doc.text(value.trim(), left + 16, lineY, { width: valueWidth, lineGap: 2 });
    } else {
      doc.fontSize(10).fillColor(INK).text(line.trim(), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
    }
    doc.moveDown(0.22);
  });
}

function drawTableBlock(doc, headers, rows, accentColor, fixedColumnFractions = null, hasHeader = true) {
  const columnCount = Math.max(1, headers?.length || 0);
  const fractions = fixedColumnFractions || tableColumnFractions(headers, rows);
  const columnWidths = fractions.map((fraction) => CONTENT_WIDTH * fraction);
  const cellPadding = 6;

  function cellsHeight(cells, header) {
    doc.font(header ? 'Body-Bold' : 'Body').fontSize(9);
    return Math.max(...cells.map((cell, index) => doc.heightOfString(cell || '', { width: columnWidths[index] - cellPadding * 2 }))) + cellPadding * 2;
  }

  function drawRow(cells, header) {
    const height = cellsHeight(cells, header);
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const rowTop = doc.y;
    cells.forEach((cell, i) => {
      const x = PAGE_MARGIN + columnWidths.slice(0, i).reduce((sum, width) => sum + width, 0);
      const columnWidth = columnWidths[i];
      if (header) {
        doc.rect(x, rowTop, columnWidth, height).fillAndStroke('#D9D9D9', INK);
      } else {
        doc.rect(x, rowTop, columnWidth, height).stroke(INK);
      }
      doc
        .font(header || (columnCount === 2 && i === 0) ? 'Body-Bold' : 'Body')
        .fontSize(9)
        .fillColor(INK)
        .text(cell || '', x + cellPadding, rowTop + cellPadding, { width: columnWidth - cellPadding * 2 });
    });
    doc.y = rowTop + height;
  }

  if (hasHeader !== false) drawRow(headers || [], true);
  (rows || []).forEach((row) => drawRow((headers || []).map((_, i) => row[i] || ''), false));
  doc.moveDown(0.5);
}

// Walker unique du modèle à blocs (voir services/procedureWord.js#blocksToDocxParagraphs pour
// l'équivalent Word — même schéma de blocs des deux côtés, seul le rendu diffère). Remplace
// l'ancien branchement drawGeneratedSection/drawSubSection sur section.subsections?.length :
// une section n'a plus qu'UNE représentation possible (section.blocks), plus de risque qu'une
// correction manuelle dans l'éditeur (qui n'écrivait que section.content) soit silencieusement
// ignorée par cet export parce qu'il préférait section.subsections.
function drawCalloutBox(doc, text, accentColor, calloutStyle) {
  doc.moveDown(0.3);
  const background = calloutStyle === 'full-tint' ? lightTint(accentColor) : '#F5F5F5';
  const height = doc.heightOfString(text, { width: CONTENT_WIDTH - 24 }) + 34;
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();

  const boxTop = doc.y;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).fill(background);
  if (calloutStyle === 'full-tint') {
    doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).lineWidth(0.75).stroke(accentColor);
  } else {
    doc.rect(PAGE_MARGIN, boxTop, 3, height).fill(accentColor);
  }
  doc.font('Body-Bold').fontSize(9).fillColor(accentColor).text("Point d'attention :", PAGE_MARGIN + 10, boxTop + 8, { width: CONTENT_WIDTH - 20 });
  doc.font('Body').fontSize(9).fillColor(INK).text(text, PAGE_MARGIN + 10, doc.y + 2, { width: CONTENT_WIDTH - 20 });
  doc.y = boxTop + height + 10;
}

function drawBlocks(doc, sectionNumber, sectionLabel, blocks, accentColor, visualOptions, onFirstContentPage) {
  if (doc.y > PAGE_MARGIN + 35) doc.moveDown(0.8);
  const headingY = doc.y;
  doc.font('Body-Bold').fontSize(11).fillColor(INK);
  if (sectionNumber) {
    doc.text(`${sectionNumber}.`, PAGE_MARGIN, headingY, { width: 24, lineGap: 2 });
    doc.text(sectionLabel, PAGE_MARGIN + 36, headingY, { width: CONTENT_WIDTH - 36, lineGap: 2 });
  } else {
    doc.text(sectionLabel, PAGE_MARGIN, headingY, { width: CONTENT_WIDTH, lineGap: 2 });
  }
  doc.font('Body');
  doc.moveDown(0.55);

  if (!blocks?.length) {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);
    return;
  }

  blocks.forEach((block, blockIndex) => {
    const blockStartPage = doc.bufferedPageRange().count;
    switch (block.type) {
      case 'sous_titre':
        doc.moveDown(0.25);
        doc.font('Body-Bold').fontSize(10).fillColor(INK).text(block.text, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
        doc.font('Body');
        doc.moveDown(0.35);
        break;
      case 'liste_puces':
        (block.items || [])
          .filter((item) => String(item || '').trim())
          .forEach((item) => drawStructuredParagraph(doc, `• ${item}`, visualOptions.bulletStyle));
        doc.moveDown(0.3);
        break;
      case 'tableau':
        drawTableBlock(doc, block.headers, block.rows, accentColor, null, block.hasHeader);
        break;
      // Aucun champ severity : un seul traitement visuel (voir plan de refonte), le rouge/ambre
      // ci-dessus reste réservé aux 2 bannières d'état réellement affichées à l'écran
      // (obsolescence/retard), jamais à un encadré rédigé.
      case 'encadre':
        drawCalloutBox(doc, block.text, accentColor, visualOptions.calloutStyle);
        break;
      case 'photo_placeholder':
        drawPhotoPlaceholder(doc, block.caption);
        break;
      case 'paragraphe':
      default:
        drawStructuredParagraph(doc, block.text, visualOptions.bulletStyle);
        doc.moveDown(0.25);
        break;
    }
    if (blockIndex === 0 && onFirstContentPage) {
      const pageAfterBlock = doc.bufferedPageRange().count;
      onFirstContentPage(block.type === 'sous_titre' ? pageAfterBlock : blockStartPage);
    }
  });

  doc.moveDown(0.4);
}

// procedure : ligne procedures (avec obsoleted_by_user résolu). version : la version dont le
// contenu est imprimé — l'appelant choisit laquelle (voir routes/procedures.js#pdf : la
// courante si elle existe, sinon la plus récente, jamais un blocage tant qu'AU MOINS une
// version existe). versions : historique complet (author/validator résolus), pour le tableau
// en bas de document. renderStyle : { accentColor } — construit par l'appelant à partir de
// procedure_templates.accent_color du tenant (voir routes/procedures.js#GET /:id/pdf), ou
// undefined si non configuré. boxBackground/boxBorder ne sont plus des réglages distincts
// depuis la refonte de la mise en page (accent_color/visual_options, voir services/
// procedureWord.js) — ce module PDF reste une adaptation minimale de compatibilité (voir
// drawBlocks) qui n'a PAS été réécrit pour suivre le nouveau système de style, contrairement au
// renderer Word ; il retombe donc toujours sur les styles neutres pour l'encadré.
// Calculé en variables LOCALES (jamais en constante de module) : plusieurs requêtes de tenants
// différents peuvent s'exécuter en concurrence dans le même process Node, une couleur globale
// mutable ferait fuiter le thème d'un tenant vers le PDF d'un autre.
export function buildProcedurePdf({
  tenantName,
  tenantAddress,
  tenantPhone,
  tenantLegalMentions,
  tenantLogo,
  procedure,
  version,
  versions,
  renderStyle,
}) {
  const accentColor = renderStyle?.accentColor || INK;
  const visualOptions = { ...DEFAULT_VISUAL_OPTIONS, ...(renderStyle?.visualOptions || {}) };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: { top: PAGE_MARGIN, bottom: 92, left: PAGE_MARGIN, right: PAGE_MARGIN },
      size: 'A4',
      bufferPages: true,
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const drawPageHeader = () => drawProcedureControlHeader(doc, { procedure, version });
    let currentPageNumber = 1;
    doc.on('pageAdded', () => {
      currentPageNumber += 1;
      if (currentPageNumber >= 3) drawPageHeader();
    });

    const manualSommaire = (version.content?.sections || []).find((section) => section.key === 'sommaire');
    const sections = (version.content?.sections || []).filter((section) => section.key !== 'sommaire');
    const documentsAssocies = version.content?.documents_associes || [];
    const tocEntries = sections.flatMap((section, index) => [
      { number: index + 1, label: section.label, sectionIndex: index, nested: false },
      ...sectionSubheadings(section).map((label) => ({ label, sectionIndex: index, nested: true })),
    ]);
    if (documentsAssocies.length) {
      tocEntries.push({
        number: sections.length + 1,
        label: 'Documents associés',
        sectionIndex: sections.length,
        nested: false,
      });
    }
    const historyIndex = sections.length + (documentsAssocies.length ? 1 : 0);
    tocEntries.push({
      number: historyIndex + 1,
      label: 'Historique des versions',
      sectionIndex: historyIndex,
      nested: false,
    });

    drawPageHeader();
    if (tenantLogo) {
      try {
        const coverLogoWidth = 220;
        const coverLogoHeight = 110;
        doc.image(tenantLogo, (PAGE_WIDTH - coverLogoWidth) / 2, (doc.page.height - coverLogoHeight) / 2, {
          fit: [coverLogoWidth, coverLogoHeight],
          align: 'center',
          valign: 'center',
        });
      } catch {
        // A logo illisible n'empêche pas l'export de la procédure.
      }
    } else {
      doc
        .font('Body-Bold')
        .fontSize(20)
        .fillColor(INK)
        .text(tenantName || 'PROCÉDURE QUALITÉ', PAGE_MARGIN, doc.page.height / 2 - 28, { width: CONTENT_WIDTH, align: 'center' });
      doc.font('Body').fontSize(14).text(procedure.title, PAGE_MARGIN, doc.page.height / 2 + 8, { width: CONTENT_WIDTH, align: 'center' });
    }

    // Page 2 reprend le bandeau gris et le sommaire tabulaire du document témoin.
    doc.addPage();
    const sommairePageIndex = 1;
    drawCompanyBand(doc, tenantName);
    const sommaireStartY = doc.y;
    doc.addPage();

    if (visualOptions.band) {
      const bandTop = doc.y + 4;
      doc.rect(PAGE_MARGIN, bandTop, CONTENT_WIDTH, 4).fill(accentColor);
      doc.y = bandTop + 12;
    }

    if (procedure.status === 'obsolete') {
      drawImportantBox(doc, {
        color: RED,
        background: RED_LIGHT,
        label: 'IMPORTANT — Procédure obsolète',
        text: `Rendue obsolète le ${formatDateTime(procedure.obsoleted_at)}${
          procedure.obsoleted_by_user?.full_name ? ` par ${procedure.obsoleted_by_user.full_name}` : ''
        }.${procedure.obsolete_reason ? ` Motif : ${procedure.obsolete_reason}` : ''}`,
      });
    } else if (procedure.next_review_date && procedure.next_review_date < new Date().toISOString().slice(0, 10)) {
      drawImportantBox(doc, {
        color: AMBER,
        background: AMBER_LIGHT,
        label: 'IMPORTANT — Révision en retard',
        text: `La date de prochaine révision (${formatDate(procedure.next_review_date)}) est dépassée.`,
      });
    }
    if (version.status !== 'approved') {
      const rejected = version.status === 'rejected';
      drawImportantBox(doc, {
        color: rejected ? RED : AMBER,
        background: rejected ? RED_LIGHT : AMBER_LIGHT,
        label: rejected ? 'IMPORTANT — Version rejetée' : 'IMPORTANT — Version non approuvée',
        text:
          version.status === 'pending'
            ? 'Cette version est en attente de validation et ne doit pas être utilisée comme version en vigueur.'
            : rejected
              ? 'Cette version a été rejetée et ne doit pas être utilisée comme version en vigueur.'
              : 'Cette version est un brouillon et ne doit pas être utilisée comme version en vigueur.',
      });
    }

    sections.forEach((section, index) => {
      const tocEntry = tocEntries.find((entry) => !entry.nested && entry.sectionIndex === index);
      tocEntry.startPage = currentPageNumber;
      drawBlocks(doc, index + 1, section.label, section.blocks, accentColor, visualOptions, (page) => {
        tocEntry.startPage = page;
      });
      tocEntry.endPage = currentPageNumber;
    });

    if (documentsAssocies.length > 0) {
      const tocEntry = tocEntries.find((entry) => !entry.nested && entry.sectionIndex === sections.length);
      tocEntry.startPage = currentPageNumber;
      doc
        .font('Body-Bold')
        .fontSize(12)
        .fillColor(accentColor)
        .text(`${sections.length + 1}. Documents associés`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.font('Body');
      doc.moveDown(0.3);
      documentsAssocies.forEach((name) => {
        doc.fontSize(10).fillColor(INK).text(`•  ${name}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.moveDown(0.15);
      });
      doc.moveDown(0.5);
      tocEntry.endPage = currentPageNumber;
    }

    // Historique des versions en annexe après le contenu : il peut poursuivre sur la dernière
    // page plutôt que de créer une page presque vide pour quelques lignes.
    const historyEntry = tocEntries.find((entry) => !entry.nested && entry.sectionIndex === historyIndex);
    historyEntry.startPage = currentPageNumber;
    doc
      .font('Body-Bold')
      .fontSize(13)
      .fillColor(accentColor)
      .text(`${historyIndex + 1}. Historique des versions`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.5);

    drawTableBlock(
      doc,
      ['Version', 'Statut', 'Rédigée par', 'Date', 'Validée par'],
      (versions || []).map((v) => [
        `v${v.version}`,
        VERSION_STATUS_LABELS[v.status] || v.status,
        v.author?.full_name || 'auteur inconnu',
        formatDate(v.created_at),
        v.validator?.full_name || '—',
      ]),
      accentColor,
      [0.2, 0.13, 0.36, 0.15, 0.16]
    );
    historyEntry.endPage = currentPageNumber;

    // Remplit la page réservée plus haut, maintenant que le numéro de page de chaque entrée est
    // connu — même technique que le pied de page ci-dessous (bufferPages + switchToPage vers une
    // page déjà créée). Sans risque de débordement en pratique (une procédure a rarement assez de
    // sections pour remplir une A4 rien qu'avec leurs libellés) ; si jamais c'était le cas,
    // pdfkit ajouterait la suite à la toute fin du document plutôt que juste après cette page.
    doc.switchToPage(sommairePageIndex);
    doc.y = sommaireStartY;
    drawTableOfContents(doc, tocEntries, manualSommaire, accentColor, visualOptions);

    // Pied de page numéroté — même construction que listReportPdf.js/qqoqccpPdf.js.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const contactLine = [tenantName, tenantAddress, tenantPhone ? `Tél. : ${tenantPhone}` : null].filter(Boolean).join(' — ');
      if (contactLine) {
        doc.font('Body').fontSize(7).fillColor(MUTED).text(contactLine, PAGE_MARGIN, doc.page.height - 69, {
          width: CONTENT_WIDTH,
          align: 'center',
          lineBreak: false,
          ellipsis: true,
        });
      }
      if (tenantLegalMentions) {
        doc.font('Body').fontSize(6.5).fillColor(MUTED).text(tenantLegalMentions, PAGE_MARGIN, doc.page.height - 57, {
          width: CONTENT_WIDTH,
          align: 'center',
          lineBreak: false,
          ellipsis: true,
        });
      }
      doc.font('Body').fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} sur ${range.count}`, PAGE_MARGIN, doc.page.height - 34, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
