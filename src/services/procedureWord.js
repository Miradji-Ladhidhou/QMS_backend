import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  AlignmentType,
  PageNumber,
  WidthType,
  ShadingType,
  VerticalAlign,
  TableLayoutType,
  HeadingLevel,
  SectionType,
  Bookmark,
  PageReference,
} from 'docx';
import { logoImageRun } from './wordLogo.js';

// Refonte de la mise en page des procédures — remplace l'ancien système à 4 presets figés
// (mtl-logistique/iso-generique/moderne-tertiaire/industriel-securite, chacun un objet
// STYLE_THEMES complet) par une personnalisation directe par tenant (accent_color/
// visual_options, voir procedure_templates dans schema.sql) : un rendu unique inspiré du
// document qualité de référence (Arial, tableau de contrôle, couverture, sommaire tabulaire,
// corps numéroté, tableaux cantSplit) piloté par les préférences visuelles du tenant, au lieu
// de mises en page distinctes. Reste un seul chemin de rendu, sans duplication par style/couleur.
const TABLE_WIDTH_DXA = 10466;

const DEFAULT_ACCENT_COLOR = '#44546A';
const DEFAULT_VISUAL_OPTIONS = { band: false, bulletStyle: 'round', calloutStyle: 'left-border' };

const FONT_FAMILY = 'Arial';
const BASE_FONT_SIZE = 22; // demi-points OOXML : 22 = 11pt, taille de corps de texte standard.

const VERSION_STATUS_LABELS = { draft: 'Brouillon', pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

function bandParagraph(style) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: hexColor(style.accentColor) },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text: ' ' })],
  });
}

function procedureNotices(procedure, version) {
  const notices = [];
  if (procedure.status === 'obsolete') {
    notices.push({
      label: 'IMPORTANT — Procédure obsolète',
      text: `Cette procédure est obsolète.${procedure.obsolete_reason ? ` Motif : ${procedure.obsolete_reason}` : ''}`,
      color: 'B91C1C',
      background: 'FEF2F2',
    });
  } else if (procedure.next_review_date && procedure.next_review_date < new Date().toISOString().slice(0, 10)) {
    notices.push({
      label: 'IMPORTANT — Révision en retard',
      text: `La date de prochaine révision (${formatDate(procedure.next_review_date)}) est dépassée.`,
      color: 'B45309',
      background: 'FFFBEB',
    });
  }

  if (version.status !== 'approved') {
    const rejected = version.status === 'rejected';
    notices.push({
      label: rejected ? 'IMPORTANT — Version rejetée' : 'IMPORTANT — Version non approuvée',
      text:
        version.status === 'pending'
          ? 'Cette version est en attente de validation et ne doit pas être utilisée comme version en vigueur.'
          : rejected
            ? 'Cette version a été rejetée et ne doit pas être utilisée comme version en vigueur.'
            : 'Cette version est un brouillon et ne doit pas être utilisée comme version en vigueur.',
      color: rejected ? 'B91C1C' : 'B45309',
      background: rejected ? 'FEF2F2' : 'FFFBEB',
    });
  }
  return notices;
}

// Fusionne les réglages du tenant avec les défauts — un tenant qui n'a jamais rien enregistré
// (procedure_templates absent, voir fetchTenantTemplate côté routes) doit produire exactement
// le même rendu qu'un tenant qui a explicitement choisi les valeurs par défaut.
function resolveStyle({ accentColor, visualOptions } = {}) {
  return {
    accentColor: accentColor || DEFAULT_ACCENT_COLOR,
    band: visualOptions?.band ?? DEFAULT_VISUAL_OPTIONS.band,
    bulletStyle: visualOptions?.bulletStyle || DEFAULT_VISUAL_OPTIONS.bulletStyle,
    calloutStyle: visualOptions?.calloutStyle || DEFAULT_VISUAL_OPTIONS.calloutStyle,
  };
}

// Retire le '#' éventuel : docx attend des couleurs hex SANS dièse (contrairement au CSS).
function hexColor(color) {
  return (color || '').replace(/^#/, '').toUpperCase() || '44546A';
}

// Teinte très claire de la couleur d'accent, pour le fond d'un encadré "full-tint" (voir
// resolveCalloutLook) — mélange à ~90% de blanc, jamais la couleur d'accent pleine en fond
// (illisible en texte noir dessus).
function lightTint(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * 0.88);
  return [mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Répartit TABLE_WIDTH_DXA entre des colonnes selon des proportions données, en garantissant que
// la somme des largeurs retournées vaut EXACTEMENT `total` — jamais un twip de plus ou de moins.
// Un simple Math.round colonne par colonne (l'ancienne approche) peut décaler cette somme de
// quelques twips par rapport à la largeur déclarée du tableau (Table.width) : LibreOffice
// tolère l'écart et affiche un résultat correct, mais Word l'interprète plus strictement et peut
// désaligner les bordures entre la ligne d'en-tête et les lignes de données (bug réel constaté
// sur le tableau du bloc "tableau" ET sur le tableau d'identité). Méthode du plus grand reste :
// arrondit chaque colonne vers le bas, puis distribue le reliquat (toujours < nombre de colonnes)
// aux colonnes qui ont le plus perdu à l'arrondi, pour rester proche des proportions demandées.
function distributeColumnWidths(total, fractions) {
  const raw = fractions.map((fraction) => total * fraction);
  const widths = raw.map(Math.floor);
  const distributed = widths.reduce((sum, w) => sum + w, 0);
  const remainder = total - distributed;
  const order = raw
    .map((value, index) => ({ index, fractional: value - Math.floor(value) }))
    .sort((a, b) => b.fractional - a.fractional);
  for (let k = 0; k < remainder; k += 1) {
    widths[order[k % order.length].index] += 1;
  }
  return widths;
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

function borderLine(color, style = BorderStyle.SINGLE, size = 6) {
  return { style, size, color, space: 6 };
}

// spacing.line en 1/240e de ligne (docx/OOXML) : 276 = 1.15 interligne, une valeur volontairement
// modeste (pas 1.5) pour ne pas gonfler artificiellement la longueur d'un document déjà détaillé
// — juste assez pour que le texte respire au lieu de former un bloc compact.
const BODY_PARAGRAPH_SPACING = { after: 80, line: 264 };

// Titres et paragraphes compacts, dans le style du document qualité de référence.
function sectionTitleParagraph(text, { pageBreakBefore = false, bookmarkId } = {}) {
  return new Paragraph({
    pageBreakBefore,
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    spacing: { before: 360, after: 100, line: 264 },
    children: [
      bookmarkId
        ? new Bookmark({ id: bookmarkId, children: [new TextRun({ text, bold: true, size: BASE_FONT_SIZE, color: '000000' })] })
        : new TextRun({ text, bold: true, size: BASE_FONT_SIZE, color: '000000' }),
    ],
  });
}

// Encadré "Point d'attention :" — un seul traitement visuel selon style.calloutStyle, jamais de
// code couleur de gravité (rouge/orange/vert supprimés avec l'ancien calloutBySeverity).
function resolveCalloutLook(style) {
  const accent = hexColor(style.accentColor);
  if (style.calloutStyle === 'full-tint') {
    return { background: lightTint(accent), border: accent };
  }
  return { background: 'F5F5F5', border: accent };
}

function boxParagraphs({ label, background, border, text, borderWidth = 6 }) {
  return [
    new Paragraph({
      border: {
        top: borderLine(border, BorderStyle.SINGLE, borderWidth),
        bottom: borderLine(border, BorderStyle.SINGLE, borderWidth),
        left: borderLine(border, BorderStyle.SINGLE, borderWidth),
        right: borderLine(border, BorderStyle.SINGLE, borderWidth),
      },
      shading: background ? { type: ShadingType.CLEAR, fill: background } : undefined,
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({ text: "Point d'attention : ", bold: true }),
        ...text.split('\n').flatMap((line, index) => (index === 0 ? [new TextRun(line)] : [new TextRun({ text: line, break: 1 })])),
      ],
    }),
  ];
}

function statusNoticeParagraphs({ label, text, color, background }) {
  const line = borderLine(color, BorderStyle.SINGLE, 8);
  return [
    new Paragraph({
      border: { top: line, bottom: line, left: line, right: line },
      shading: { type: ShadingType.CLEAR, fill: background },
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: `${label} : `, bold: true, color }), new TextRun({ text, color })],
    }),
  ];
}

function calloutParagraphs(style, text) {
  if (!text) return [];
  const look = resolveCalloutLook(style);
  // "left-border" : bordure gauche épaisse seule (les 3 autres côtés restent fins/invisibles),
  // fond gris très clair. "full-tint" : encadré complet teinté de la couleur d'accent.
  if (style.calloutStyle === 'full-tint') {
    return boxParagraphs({ background: look.background, border: look.border, text });
  }
  return [
    new Paragraph({
      border: { left: borderLine(look.border, BorderStyle.SINGLE, 36) },
      shading: { type: ShadingType.CLEAR, fill: look.background },
      indent: { left: 60 },
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({ text: "Point d'attention : ", bold: true }),
        ...text.split('\n').flatMap((line, index) => (index === 0 ? [new TextRun(line)] : [new TextRun({ text: line, break: 1 })])),
      ],
    }),
  ];
}

// Élément commun (voir spec) : chaque légende identifiée par l'IA (bloc photo_placeholder,
// voir services/procedureFullDraftJob.js) devient un encadré en pointillés, pour que le
// rédacteur n'ait plus qu'à remplacer la zone par sa propre image dans Word.
function photoPlaceholderParagraphs(caption) {
  return [
    new Paragraph({
      border: {
        top: borderLine('999999', BorderStyle.DASHED, 4),
        bottom: borderLine('999999', BorderStyle.DASHED, 4),
        left: borderLine('999999', BorderStyle.DASHED, 4),
        right: borderLine('999999', BorderStyle.DASHED, 4),
      },
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: `[ Emplacement réservé à une photo : ${caption} ]`, italics: true, color: '666666' })],
    }),
  ];
}

function listParagraph(text, { ordered = false, nested = false, continuation = false } = {}) {
  const left = nested ? 1080 : 720;
  const hanging = continuation ? 0 : 360;
  return new Paragraph({
    indent: { left, hanging },
    spacing: { before: 20, after: 70, line: 276 },
    children: [new TextRun(text)],
  });
}

function bulletParagraphs(style, items) {
  const prefix = style.bulletStyle === 'round' ? '•' : '–';
  return (items || []).flatMap((item) => {
    const value = String(item || '').trim();
    if (!value) return [];
    const lines = value.split('\n');
    return lines.map((line, index) =>
      listParagraph(index === 0 ? `${prefix} ${line.trim()}` : line.trim(), { continuation: index > 0 })
    );
  });
}

function paragrapheParagraphs(text, bulletStyle = DEFAULT_VISUAL_OPTIONS.bulletStyle) {
  return (text || '').split('\n').map((line) => {
    const subsection = line.match(/^\s*(\d+\.\d+)\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (subsection) return sousTitreParagraph(`${subsection[1]}    ${subsection[2]}`);
    if (bullet) return listParagraph(`${bulletStyle === 'round' ? '•' : '–'} ${bullet[1]}`, { nested: /^\s{2,}/.test(line) });
    if (ordered) return listParagraph(`${ordered[1]}. ${ordered[2]}`, { ordered: true, nested: /^\s{2,}/.test(line) });
    return new Paragraph({ spacing: BODY_PARAGRAPH_SPACING, children: [new TextRun(line.trim())] });
  });
}

function sousTitreParagraph(text, bookmarkId) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 160, after: 50, line: 264 },
    children: [
      bookmarkId
        ? new Bookmark({ id: bookmarkId, children: [new TextRun({ text, bold: true, color: '000000' })] })
        : new TextRun({ text, bold: true, color: '000000' }),
    ],
  });
}

function tableCellText(text, { header, style, width } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: lightTint(hexColor(style.accentColor)) } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text, bold: !!header, size: header ? BASE_FONT_SIZE : BASE_FONT_SIZE - 1, color: header ? hexColor(style.accentColor) : undefined })] })],
  });
}

// Bloc tableau à colonnes/lignes libres (constructeur manuel, voir
// frontend/src/components/TableBlockEditor.jsx) — répartition égale de la largeur sur le
// nombre réel de colonnes, en-tête gris clair/texte couleur d'accent, bordures fines noires,
// cantSplit sur CHAQUE ligne pour ne jamais la couper entre deux pages (bug déjà rencontré et
// corrigé sur le document de référence — propriété qui n'était utilisée nulle part avant cette
// refonte).
function tableBlockToDocxTable(block, style) {
  const columnCount = Math.max(1, block.headers?.length || 0);
  const columnWidths = distributeColumnWidths(
    TABLE_WIDTH_DXA,
    tableColumnFractions(block.headers, block.rows)
  );
  const thinBlackBorder = borderLine('000000', BorderStyle.SINGLE, 4);
  const cellBorders = { top: thinBlackBorder, bottom: thinBlackBorder, left: thinBlackBorder, right: thinBlackBorder };

  function cell(text, header, columnIndex) {
    return new TableCell({
      width: { size: columnWidths[columnIndex], type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, fill: 'D9D9D9' } : undefined,
      borders: cellBorders,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({ children: [new TextRun({ text: text || '', bold: !!header || (columnCount === 2 && columnIndex === 0) })] }),
      ],
    });
  }

  const headerRows =
    block.hasHeader === false
      ? []
      : [
          new TableRow({
            cantSplit: true,
            children: (block.headers || []).map((h, i) => cell(h, true, i)),
          }),
        ];
  const dataRows = (block.rows || []).map(
    (row) => new TableRow({ cantSplit: true, children: columnWidths.map((_, i) => cell(row[i], false, i)) })
  );

  return new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED, rows: [...headerRows, ...dataRows] });
}

// Le walker unique du modèle à blocs (voir schéma dans le plan de refonte) : un switch sur
// block.type, appelé une fois par section — remplace entièrement l'ancien branchement
// "section.subsections?.length ? ... : flatSectionBodyParagraphs(section)".
function blocksToDocxParagraphs(blocks, style, firstBookmarkId) {
  return (blocks || []).flatMap((block, index) => {
    switch (block.type) {
      case 'sous_titre':
        return [sousTitreParagraph(block.text, index === 0 ? firstBookmarkId : undefined)];
      case 'liste_puces':
        return bulletParagraphs(style, block.items);
      case 'tableau':
        return [tableBlockToDocxTable(block, style)];
      case 'encadre':
        return calloutParagraphs(style, block.text);
      case 'photo_placeholder':
        return photoPlaceholderParagraphs(block.caption);
      case 'paragraphe':
      default:
        return paragrapheParagraphs(block.text, style.bulletStyle);
    }
  });
}

function controlHeaderCell(text, width, { bold = false, accentColor = DEFAULT_ACCENT_COLOR } = {}) {
  const border = borderLine('000000', BorderStyle.SINGLE, 3);
  const children = String(text)
    .split('\n')
    .map((line, index) => new TextRun({ text: line, bold, size: 16, color: accentColor, break: index > 0 ? 1 : undefined }));
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 55, bottom: 55, left: 95, right: 95 },
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({ spacing: { after: 0, line: 230 }, children })],
  });
}

function procedureControlHeader({ style, procedure, version }) {
  const accent = hexColor(style.accentColor);
  const columnWidths = distributeColumnWidths(TABLE_WIDTH_DXA, [0.52, 0.48]);
  const revisionDate = formatDate(version.validated_at || version.created_at || procedure.updated_at);
  const versionStatus = VERSION_STATUS_LABELS[version.status] || version.status;
  const effectiveVersionStatus =
    version.status === 'approved' && version.id === procedure.current_version_id ? `${versionStatus} — en vigueur` : versionStatus;
  const rows = [
    [
      ['PROCÉDURE DU SYSTÈME DE GESTION DE LA QUALITÉ', true],
      [`DATE DE CRÉATION : ${formatDate(procedure.created_at)}`, false],
    ],
    [
      [`TITRE : ${procedure.title}`, true],
      [
        `DOCUMENT N° : ${procedure.number}\nVERSION N° : ${version.version} (${effectiveVersionStatus})\nDATE DE RÉVISION : ${revisionDate}\nPROCHAINE RÉVISION : ${formatDate(
          procedure.next_review_date
        )}`,
        false,
      ],
    ],
    [
      [`RÉVISÉ PAR : ${version.author?.full_name || '—'}`, false],
      [`VALIDÉ PAR : ${version.validator?.full_name || '—'}`, false],
    ],
  ];
  const tableRows = rows.map(
    (cells) =>
      new TableRow({
        cantSplit: true,
        children: cells.map(([text, bold], index) =>
          controlHeaderCell(text, columnWidths[index], { bold, accentColor: accent })
        ),
      })
  );
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    rows: tableRows,
  });
}

function historyTable(style, versions) {
  const columnWidths = distributeColumnWidths(TABLE_WIDTH_DXA, [0.2, 0.13, 0.36, 0.15, 0.16]);
  const headerRow = new TableRow({
    cantSplit: true,
    children: ['Version', 'Statut', 'Rédigée par', 'Date', 'Validée par'].map((text, i) =>
      tableCellText(text, { header: true, style, width: columnWidths[i] })
    ),
  });
  const rows = (versions || []).map(
    (v) =>
      new TableRow({
        cantSplit: true,
        children: [
          tableCellText(`v${v.version}`, { style, width: columnWidths[0] }),
          tableCellText(VERSION_STATUS_LABELS[v.status] || v.status, { style, width: columnWidths[1] }),
          tableCellText(v.author?.full_name || 'auteur inconnu', { style, width: columnWidths[2] }),
          tableCellText(formatDate(v.created_at), { style, width: columnWidths[3] }),
          tableCellText(v.validator?.full_name || '—', { style, width: columnWidths[4] }),
        ],
      })
  );
  return new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED, rows: [headerRow, ...rows] });
}

function documentsAssociesParagraphs(documentsAssocies) {
  if (!documentsAssocies?.length) return [];
  return documentsAssocies.map((name) => listParagraph(`– ${name}`));
}

function coverCompanyBand(companyName) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    shading: { type: ShadingType.CLEAR, fill: 'E7E6E6' },
    spacing: { before: 80, after: 80, line: 600 },
    children: [new TextRun({ text: companyName || 'PROCÉDURE QUALITÉ', size: 32, color: '000000' })],
  });
}

function tocEntriesFor(sections, documentsAssocies) {
  const entries = sections.flatMap((section, sectionIndex) => [
    { label: section.label, sectionIndex, number: sectionIndex + 1, nested: false },
    ...section.blocks.flatMap((block) => {
      if (block.type === 'sous_titre' && block.text?.trim()) return [{ label: block.text.trim(), sectionIndex, nested: true }];
      if (block.type === 'paragraphe') {
        return String(block.text || '')
          .split('\n')
          .flatMap((line) => {
            const match = line.match(/^\s*\d+\.\d+\s+(.+)$/);
            return match ? [{ label: match[1].trim(), sectionIndex, nested: true }] : [];
          });
      }
      return [];
    }),
  ]);

  if (documentsAssocies.length) {
    entries.push({ label: 'Documents associés', sectionIndex: sections.length, number: sections.length + 1, nested: false });
  }
  const historyIndex = sections.length + (documentsAssocies.length ? 1 : 0);
  entries.push({ label: 'Historique des versions', sectionIndex: historyIndex, number: historyIndex + 1, nested: false });
  return entries;
}

function tocPageParagraphs(entries, sectionBookmarkIds) {
  const widths = distributeColumnWidths(TABLE_WIDTH_DXA, [0.8, 0.2]);
  const noBorder = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  const borders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
  const rows = entries.map((entry) => {
    const main = !entry.nested;
    const title = main
      ? new TextRun({ text: `${entry.number}.   ${entry.label}`, bold: true, size: 21 })
      : new TextRun({ text: `•   ${entry.label}`, size: 20 });
    const labelChildren =
      main && entry.sectionIndex < sectionBookmarkIds.length
        ? [new Bookmark({ id: `toc_link_${entry.sectionIndex}`, children: [title] })]
        : [title];
    const pageChildren =
      main && entry.sectionIndex < sectionBookmarkIds.length
        ? [new TextRun({ text: 'page ' }), new PageReference(sectionBookmarkIds[entry.sectionIndex], { hyperlink: true })]
        : [];
    return new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: widths[0], type: WidthType.DXA },
          borders,
          margins: { top: 20, bottom: 20, left: entry.nested ? 360 : 80, right: 40 },
          children: [new Paragraph({ spacing: { after: 35, line: 250 }, children: labelChildren })],
        }),
        new TableCell({
          width: { size: widths[1], type: WidthType.DXA },
          borders,
          margins: { top: 20, bottom: 20, left: 20, right: 80 },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 35, line: 250 }, children: pageChildren })],
        }),
      ],
    });
  });
  return new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows });
}

// content : procedure_versions.content — { sections: [{key,label,blocks:[...]}],
// documents_associes: [...] } (modèle à blocs, voir le plan de refonte ; plus de champs
// objet/domaine_application/responsabilites séparés, repliés en sections ordinaires).
// accentColor/visualOptions : procedure_templates.accent_color/visual_options du tenant (ou
// les défauts, voir resolveStyle). tenantLogo : Buffer (PNG/JPEG/WEBP/GIF) ou null/undefined —
// absent, l'emplacement logo est simplement omis, jamais un cadre vide.
// tenantName n'est PAS un paramètre : le nom de l'entreprise n'a pas d'emplacement dédié dans la
// mise en page de référence (titre/sous-titre/tableau d'identité/en-tête ne le mentionnent pas,
// voir le plan de refonte) — seul le logo l'identifie visuellement. Un appelant qui le passe
// quand même (par symétrie avec buildProcedurePdf, qui l'affiche lui dans son bandeau neutre) ne
// casse rien : une clé en trop dans l'objet est simplement ignorée.
export async function buildProcedureWordDocument({
  accentColor,
  visualOptions,
  tenantLogo,
  tenantName,
  tenantAddress,
  tenantPhone,
  tenantLegalMentions,
  procedure,
  version,
  versions,
}) {
  const style = resolveStyle({ accentColor, visualOptions });
  const content = version.content || {};
  const sections = content.sections || [];
  const manualSommaire = sections.find((section) => section.key === 'sommaire');
  const bodySections = sections.filter((section) => section.key !== 'sommaire');
  const documentsAssocies = content.documents_associes || [];
  const tocEntries = tocEntriesFor(bodySections, documentsAssocies);
  const sectionBookmarkIds = tocEntries
    .filter((entry) => !entry.nested)
    .map((entry) => `procedure_section_${entry.sectionIndex}`);
  const toc = [
    new Paragraph({
      spacing: { before: 180, after: 100 },
      children: [new TextRun({ text: 'Sommaire', bold: true, size: BASE_FONT_SIZE + 4 })],
    }),
    tocPageParagraphs(tocEntries, sectionBookmarkIds),
  ];
  if (manualSommaire?.blocks?.length) {
    toc.push(new Paragraph({ spacing: { before: 180, after: 80 }, children: [new TextRun({ text: 'Notes du sommaire', bold: true, color: '44546A' })] }));
    toc.push(...blocksToDocxParagraphs(manualSommaire.blocks, style));
  }

  const body = [
    ...(style.band ? [bandParagraph(style)] : []),
    ...procedureNotices(procedure, version).flatMap(statusNoticeParagraphs),
  ];
  bodySections.forEach((section, index) => {
    const bookmarkFirstSubheading = section.blocks?.[0]?.type === 'sous_titre';
    body.push(
      sectionTitleParagraph(`${index + 1}.    ${section.label}`, {
        bookmarkId: bookmarkFirstSubheading ? undefined : sectionBookmarkIds[index],
      })
    );
    body.push(...blocksToDocxParagraphs(section.blocks, style, bookmarkFirstSubheading ? sectionBookmarkIds[index] : undefined));
  });

  const historyIndex = bodySections.length + (documentsAssocies.length ? 1 : 0);
  if (documentsAssocies.length) {
    body.push(
      sectionTitleParagraph(`${bodySections.length + 1}.    Documents associés`, {
        bookmarkId: sectionBookmarkIds[bodySections.length],
      })
    );
    body.push(...documentsAssociesParagraphs(documentsAssocies));
  }

  body.push(
    sectionTitleParagraph(`${historyIndex + 1}.    Historique des versions`, {
      bookmarkId: sectionBookmarkIds[historyIndex],
    })
  );
  body.push(historyTable(style, versions));

  const coverLogo = logoImageRun(tenantLogo, { maxWidth: 220, maxHeight: 110 });
  const companyContact = [tenantName, tenantAddress, tenantPhone ? `Tél. : ${tenantPhone}` : null].filter(Boolean).join(' · ');
  const headerChildren = [procedureControlHeader({ style, procedure, version })];
  const coverChildren = [
    procedureControlHeader({ style, procedure, version }),
    ...(coverLogo
    ? [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 3900 },
          children: [coverLogo],
        }),
      ]
    : [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 4300, after: 160 },
          children: [new TextRun({ text: tenantName || 'PROCEDURE QUALITÉ', bold: true, size: 36 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 3900 },
          children: [new TextRun({ text: procedure.title, size: 26 })],
        }),
      ]),
  ];

  function createFooter() {
    return new Footer({
      children: [
        ...(companyContact
          ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: [new TextRun({ text: companyContact, size: 14, color: '777777' })] })]
          : []),
        ...(tenantLegalMentions
          ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: [new TextRun({ text: tenantLegalMentions, size: 13, color: '777777' })] })]
          : []),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'Page ', size: 16, color: '888888' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888' }),
            new TextRun({ text: ' sur ', size: 16, color: '888888' }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '888888' }),
          ],
        }),
      ],
    });
  }

  const doc = new Document({
    features: { updateFields: true },
    styles: { default: { document: { run: { font: FONT_FAMILY, size: BASE_FONT_SIZE } } } },
    sections: [
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720, header: 708, footer: 708, gutter: 0 } },
        },
        footers: { default: createFooter() },
        children: coverChildren,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720, header: 708, footer: 708, gutter: 0 } },
        },
        footers: { default: createFooter() },
        children: [coverCompanyBand(tenantName), ...toc],
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720, header: 708, footer: 708, gutter: 0 } },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: { default: createFooter() },
        children: body,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
