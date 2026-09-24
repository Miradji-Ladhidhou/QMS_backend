import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE, HEADER_FILL, drawLetterheadHeader } from './pdfTheme.js';

// RED/AMBER restent des couleurs sémantiques (obsolescence/retard), pas des couleurs de
// marque — volontairement non touchées par le passage à l'en-tête neutre.
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';
const AMBER = '#b45309';
const AMBER_LIGHT = '#fffbeb';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const PROCEDURE_STATUS_LABELS = { draft: 'Brouillon', in_review: 'En revue', approved: 'Approuvé', obsolete: 'Obsolète' };
const VERSION_STATUS_LABELS = { draft: 'Brouillon', pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

function formatDateTime(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleString('fr-FR') : '—';
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
function drawStructuredParagraph(doc, text) {
  const lines = String(text || '').split('\n');
  lines.forEach((line) => {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const nested = /^\s{2,}/.test(line);
    if (bullet || ordered) {
      const marker = ordered ? `${ordered[1]}.` : '•';
      const value = ordered ? ordered[2] : bullet[1];
      const left = PAGE_MARGIN + (nested ? 28 : 14);
      doc.fontSize(10).fillColor(INK).text(marker, left, doc.y, { width: 14 });
      doc.text(value.trim(), left + 16, doc.y, { width: CONTENT_WIDTH - (left - PAGE_MARGIN) - 16, lineGap: 2 });
    } else {
      doc.fontSize(10).fillColor(INK).text(line.trim(), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
    }
    doc.moveDown(0.22);
  });
}

function drawTableBlock(doc, headers, rows, accentColor) {
  const columnCount = Math.max(1, headers?.length || 0);
  const columnWidth = CONTENT_WIDTH / columnCount;
  const cellPadding = 6;

  function cellsHeight(cells, header) {
    doc.font(header ? 'Body-Bold' : 'Body').fontSize(9);
    return Math.max(...cells.map((c) => doc.heightOfString(c || '', { width: columnWidth - cellPadding * 2 }))) + cellPadding * 2;
  }

  function drawRow(cells, header) {
    const height = cellsHeight(cells, header);
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const rowTop = doc.y;
    cells.forEach((cell, i) => {
      const x = PAGE_MARGIN + i * columnWidth;
      if (header) {
        doc.rect(x, rowTop, columnWidth, height).fillAndStroke(HEADER_FILL, RULE);
      } else {
        doc.rect(x, rowTop, columnWidth, height).stroke(RULE);
      }
      doc
        .font(header ? 'Body-Bold' : 'Body')
        .fontSize(9)
        .fillColor(header ? accentColor : INK)
        .text(cell || '', x + cellPadding, rowTop + cellPadding, { width: columnWidth - cellPadding * 2 });
    });
    doc.y = rowTop + height;
  }

  drawRow(headers || [], true);
  (rows || []).forEach((row) => drawRow((headers || []).map((_, i) => row[i] || ''), false));
  doc.moveDown(0.5);
}

// Walker unique du modèle à blocs (voir services/procedureWord.js#blocksToDocxParagraphs pour
// l'équivalent Word — même schéma de blocs des deux côtés, seul le rendu diffère). Remplace
// l'ancien branchement drawGeneratedSection/drawSubSection sur section.subsections?.length :
// une section n'a plus qu'UNE représentation possible (section.blocks), plus de risque qu'une
// correction manuelle dans l'éditeur (qui n'écrivait que section.content) soit silencieusement
// ignorée par cet export parce qu'il préférait section.subsections.
function drawBlocks(doc, sectionNumber, sectionLabel, blocks, accentColor, infoBoxStyle) {
  if (doc.y > PAGE_MARGIN + 35) doc.moveDown(0.8);
  doc.font('Body-Bold').fontSize(12).fillColor(accentColor).text(`${sectionNumber}. ${sectionLabel}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
  doc.font('Body');
  doc.moveDown(0.55);

  if (!blocks?.length) {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);
    return;
  }

  blocks.forEach((block) => {
    switch (block.type) {
      case 'sous_titre':
        doc.moveDown(0.25);
        doc.font('Body-Bold').fontSize(11).fillColor(accentColor).text(block.text, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
        doc.font('Body');
        doc.moveDown(0.35);
        break;
      case 'liste_puces':
        (block.items || []).forEach((item) => drawStructuredParagraph(doc, `• ${item}`));
        doc.moveDown(0.3);
        break;
      case 'tableau':
        drawTableBlock(doc, block.headers, block.rows, accentColor);
        break;
      // Aucun champ severity : un seul traitement visuel (voir plan de refonte), le rouge/ambre
      // ci-dessus reste réservé aux 2 bannières d'état réellement affichées à l'écran
      // (obsolescence/retard), jamais à un encadré rédigé.
      case 'encadre':
        drawImportantBox(doc, { color: infoBoxStyle.border, background: infoBoxStyle.background, label: 'IMPORTANT', text: block.text });
        break;
      case 'photo_placeholder':
        drawPhotoPlaceholder(doc, block.caption);
        break;
      case 'paragraphe':
      default:
        drawStructuredParagraph(doc, block.text);
        doc.moveDown(0.25);
        break;
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
// renderer Word ; il retombe donc toujours sur le défaut neutre HEADER_FILL/RULE pour l'encadré.
// Calculé en variables LOCALES (jamais en constante de module) : plusieurs requêtes de tenants
// différents peuvent s'exécuter en concurrence dans le même process Node, une couleur globale
// mutable ferait fuiter le thème d'un tenant vers le PDF d'un autre.
export function buildProcedurePdf({ tenantName, tenantLogo, procedure, version, versions, renderStyle }) {
  const accentColor = renderStyle?.accentColor || INK;
  const infoBoxStyle = { background: HEADER_FILL, border: RULE };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `${procedure.number} — ${procedure.title}` };

    // Suit la page courante pour construire le sommaire (voir plus bas) — incrémenté au même
    // rythme que les pages réellement ajoutées, y compris la page réservée au sommaire lui-même.
    let currentPageNumber = 1;
    doc.on('pageAdded', () => {
      currentPageNumber += 1;
      drawLetterheadHeader(doc, headerArgs);
    });

    drawLetterheadHeader(doc, headerArgs);

    doc.moveDown(0.8);
    doc.font('Body-Bold').fontSize(18).fillColor(accentColor).text('PROCÉDURE', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.font('Body-Bold').fontSize(13).fillColor(INK).text(`${procedure.number} — ${procedure.title}`, PAGE_MARGIN, doc.y + 5, { width: CONTENT_WIDTH, align: 'center' });
    doc.font('Body').fontSize(9).fillColor(MUTED).text(`Entreprise : ${tenantName || '—'}`, PAGE_MARGIN, doc.y + 5, { width: CONTENT_WIDTH, align: 'center' });
    doc.moveDown(1);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Processus : ${procedure.process || 'non précisé'}    —    Statut : ${
          PROCEDURE_STATUS_LABELS[procedure.status] || procedure.status
        }    —    Version imprimée : v${version.version}${version.id === procedure.current_version_id ? ' (en vigueur)' : ''}`,
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );
    doc.text(`Prochaine révision : ${formatDate(procedure.next_review_date)}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);

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

    // Objet/domaine d'application/responsabilités ne sont plus des champs séparés (voir le plan
    // de refonte de la mise en page des procédures) : ce sont des sections ordinaires en tête de
    // "sections", numérotées et sommairées exactement comme les autres.
    const sections = (version.content?.sections || []).filter((section) => section.key !== 'sommaire');
    const documentsAssocies = version.content?.documents_associes || [];

    // Le sommaire est un bloc de contenu comme un autre (voir le plan de refonte) : une section
    // portant la clé "sommaire" — ajoutée par défaut par l'éditeur ou réécrite librement à la
    // main — est déjà rendue par la boucle sections.forEach ci-dessous, sans aucun traitement
    // spécial (jamais régénérée/écrasée automatiquement). Le mécanisme ci-dessous (page réservée
    // + numéros de page par entrée) ne sert donc QUE de repli pour le contenu qui n'a encore
    // aucune section "sommaire" explicite (contenu migré, ou tenant qui n'en a jamais ajouté) —
    // jamais les deux en même temps, sous peine de doublon. Le seuil de 3 reprend celui de
    // l'écran (ProcedureContentView.jsx) : sous 3 entrées, naviguer n'apporte rien face à un
    // document déjà court.
    const tocLabels = [...sections.map((s) => s.label), documentsAssocies.length > 0 && 'Documents associés', 'Historique des versions'].filter(Boolean);

    let sommairePageIndex = null;
    let sommaireStartY = null;
    const tocEntries = [];
    if (tocLabels.length >= 3) {
      doc.addPage(); // page réservée, remplie plus bas une fois les numéros de page connus
      sommairePageIndex = currentPageNumber - 1; // pages sont indexées à partir de 0, currentPageNumber à partir de 1
      sommaireStartY = doc.y;
      doc.addPage(); // le contenu réel reprend sur une page fraîche, jamais sur la page réservée
    }

    doc.moveDown(0.5);
    sections.forEach((section, index) => {
      tocEntries.push({ label: section.label, page: currentPageNumber });
      drawBlocks(doc, index + 1, section.label, section.blocks, accentColor, infoBoxStyle);
    });

    if (documentsAssocies.length > 0) {
      tocEntries.push({ label: 'Documents associés', page: currentPageNumber });
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
    }

    // Historique des versions en bas de document — traçabilité qualité, même esprit que le
    // tableau "Historique des versions" déjà affiché sur ProcedureDetail.jsx. Sur sa propre page,
    // même logique que le corps de la procédure ci-dessus : un tableau de traçabilité mélangé au
    // texte qui précède se perdait visuellement plutôt que de se lire comme une annexe à part.
    doc.addPage();
    tocEntries.push({ label: 'Historique des versions', page: currentPageNumber });
    doc.font('Body-Bold').fontSize(13).fillColor(accentColor).text('Historique des versions', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.5);

    (versions || []).forEach((v) => {
      doc
        .font('Body-Bold')
        .fontSize(9.5)
        .fillColor(INK)
        .text(`v${v.version} — ${VERSION_STATUS_LABELS[v.status] || v.status}`, PAGE_MARGIN, doc.y, {
          width: CONTENT_WIDTH,
          continued: false,
        });
      doc.font('Body');
      const authorLine = `Rédigée par ${v.author?.full_name || 'auteur inconnu'} le ${formatDate(v.created_at)}`;
      const validatorLine = v.validator?.full_name
        ? ` — ${v.status === 'rejected' ? 'Rejetée' : 'Validée'} par ${v.validator.full_name} le ${formatDate(v.validated_at)}`
        : '';
      doc.fontSize(8.5).fillColor(MUTED).text(authorLine + validatorLine, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.5);
    });

    // Remplit la page réservée plus haut, maintenant que le numéro de page de chaque entrée est
    // connu — même technique que le pied de page ci-dessous (bufferPages + switchToPage vers une
    // page déjà créée). Sans risque de débordement en pratique (une procédure a rarement assez de
    // sections pour remplir une A4 rien qu'avec leurs libellés) ; si jamais c'était le cas,
    // pdfkit ajouterait la suite à la toute fin du document plutôt que juste après cette page.
    if (sommairePageIndex !== null) {
      doc.switchToPage(sommairePageIndex);
      doc.y = sommaireStartY;
      doc.font('Body-Bold').fontSize(14).fillColor(accentColor).text('Sommaire', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.font('Body');
      doc.moveDown(0.8);
      tocEntries.forEach((entry) => {
        const rowY = doc.y;
        doc.fontSize(10).fillColor(INK).text(entry.label, PAGE_MARGIN, rowY, { width: CONTENT_WIDTH - 50 });
        doc.fontSize(10).fillColor(MUTED).text(String(entry.page), PAGE_MARGIN, rowY, { width: CONTENT_WIDTH, align: 'right' });
        doc.moveDown(0.5);
      });
    }

    // Pied de page numéroté — même construction que listReportPdf.js/qqoqccpPdf.js.
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
