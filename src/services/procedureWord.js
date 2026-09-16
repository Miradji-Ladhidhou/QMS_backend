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
  ImageRun,
  BorderStyle,
  AlignmentType,
  PageNumber,
  WidthType,
  ShadingType,
  VerticalAlign,
  TableLayoutType,
  TabStopType,
} from 'docx';
import imageSize from 'image-size';

// Refonte de la mise en page des procédures — remplace l'ancien système à 4 presets figés
// (mtl-logistique/iso-generique/moderne-tertiaire/industriel-securite, chacun un objet
// STYLE_THEMES complet) par une personnalisation directe par tenant (accent_color/
// visual_options, voir procedure_templates dans schema.sql) : un seul rendu de référence
// (Calibri, tableau d'identité, sommaire auto-généré, titres soulignés, tableaux cantSplit,
// encadré unique) piloté par 3 réglages (couleur, bandeau, style de puce/encadré), au lieu de 4
// mises en page distinctes. Reste UN SEUL chemin de rendu (voir buildProcedureWordDocument),
// aucune duplication par style/couleur.
const TABLE_WIDTH_DXA = 9026;

const DEFAULT_ACCENT_COLOR = '#44546A';
const DEFAULT_VISUAL_OPTIONS = { band: false, bulletStyle: 'dash', calloutStyle: 'left-border' };

const FONT_FAMILY = 'Calibri';
const BASE_FONT_SIZE = 22; // demi-points OOXML : 22 = 11pt, taille de corps de texte standard.

// Logo agrandi mais borné : une hauteur fixe, jamais de déformation (largeur calculée depuis
// les dimensions réelles de l'image, voir logoImageRun ci-dessous).
const LOGO_MAX_HEIGHT_PT = 40;

const PROCEDURE_STATUS_LABELS = { draft: 'Brouillon', in_review: 'En revue', approved: 'Approuvé', obsolete: 'Obsolète' };
const VERSION_STATUS_LABELS = { draft: 'Brouillon', pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
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

function borderLine(color, style = BorderStyle.SINGLE, size = 6) {
  return { style, size, color, space: 6 };
}

// Retire une numérotation que le modèle ajoute parfois lui-même malgré la consigne du prompt
// (voir services/procedureFullDraftJob.js#stripLeadingNumbering, même correctif appliqué ici
// indépendamment car ce renderer construit lui-même le texte final du bloc).
function stripLeadingNumbering(text) {
  return (text || '').replace(/^\s*\d+[.)]\s*/, '');
}

// spacing.line en 1/240e de ligne (docx/OOXML) : 276 = 1.15 interligne, une valeur volontairement
// modeste (pas 1.5) pour ne pas gonfler artificiellement la longueur d'un document déjà détaillé
// — juste assez pour que le texte respire au lieu de former un bloc compact.
const BODY_PARAGRAPH_SPACING = { after: 120, line: 276 };

// Titre de section : un seul traitement (filet gris fin en dessous), plus de bandeau plein par
// section — le bandeau devient une option page 1 uniquement (voir visualOptions.band côté
// buildProcedureWordDocument). pageBreakBefore réservé aux ruptures de chapitre réelles (début
// du corps de la procédure, historique des versions).
function sectionTitleParagraph(text, { pageBreakBefore = false } = {}) {
  return new Paragraph({
    pageBreakBefore,
    spacing: { before: 200, after: 100 },
    border: { bottom: borderLine('999999', BorderStyle.SINGLE, 4) },
    children: [new TextRun({ text, bold: true, size: BASE_FONT_SIZE + 6 })],
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

function bulletParagraphs(style, items) {
  const prefix = style.bulletStyle === 'round' ? '•  ' : '-  ';
  return (items || []).map(
    (item) => new Paragraph({ indent: { left: 240 }, spacing: BODY_PARAGRAPH_SPACING, children: [new TextRun(`${prefix}${item}`)] })
  );
}

function paragrapheParagraphs(text) {
  // Une ligne vide dans le texte source (saut de paragraphe volontaire) devient un paragraphe
  // vide plutôt que d'être avalée, pour préserver la mise en forme telle que saisie/générée.
  return (text || '').split('\n').map((line) => new Paragraph({ spacing: BODY_PARAGRAPH_SPACING, children: [new TextRun(stripLeadingNumbering(line))] }));
}

function sousTitreParagraph(text) {
  return new Paragraph({ spacing: { before: 160, after: 60 }, children: [new TextRun({ text, bold: true })] });
}

function tableCellText(text, { header, style, width } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: 'F2F2F2' } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!header, color: header ? hexColor(style.accentColor) : undefined })] })],
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
  const columnWidth = Math.round(TABLE_WIDTH_DXA / columnCount);
  const columnWidths = new Array(columnCount).fill(columnWidth);
  const thinBlackBorder = borderLine('000000', BorderStyle.SINGLE, 2);
  const cellBorders = { top: thinBlackBorder, bottom: thinBlackBorder, left: thinBlackBorder, right: thinBlackBorder };

  function cell(text, header) {
    return new TableCell({
      width: { size: columnWidth, type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, fill: 'F2F2F2' } : undefined,
      borders: cellBorders,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({ children: [new TextRun({ text: text || '', bold: !!header, color: header ? hexColor(style.accentColor) : undefined })] }),
      ],
    });
  }

  const headerRow = new TableRow({
    cantSplit: true,
    children: (block.headers || []).map((h) => cell(h, true)),
  });
  const dataRows = (block.rows || []).map(
    (row) => new TableRow({ cantSplit: true, children: columnWidths.map((_, i) => cell(row[i], false)) })
  );

  return new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED, rows: [headerRow, ...dataRows] });
}

// Le walker unique du modèle à blocs (voir schéma dans le plan de refonte) : un switch sur
// block.type, appelé une fois par section — remplace entièrement l'ancien branchement
// "section.subsections?.length ? ... : flatSectionBodyParagraphs(section)".
function blocksToDocxParagraphs(blocks, style) {
  return (blocks || []).flatMap((block) => {
    switch (block.type) {
      case 'sous_titre':
        return [sousTitreParagraph(block.text)];
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
        return paragrapheParagraphs(block.text);
    }
  });
}

function identityTable(style, { procedure, version }) {
  const rows = [
    ['Numéro', procedure.number],
    ['Titre', procedure.title],
    ['Processus', procedure.process || 'non précisé'],
    ['Statut', PROCEDURE_STATUS_LABELS[procedure.status] || procedure.status],
    ['Version', `v${version.version} (${VERSION_STATUS_LABELS[version.status] || version.status})`],
    ['Rédigée par', version.author?.full_name || 'auteur inconnu'],
    ['Validée par', version.validator?.full_name || (version.status === 'approved' ? '—' : 'en attente')],
    ['Prochaine révision', formatDate(procedure.next_review_date)],
  ];
  const columnWidths = [Math.round(TABLE_WIDTH_DXA * 0.25), Math.round(TABLE_WIDTH_DXA * 0.75)];
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          cantSplit: true,
          children: [
            tableCellText(label, { header: true, style, width: columnWidths[0] }),
            tableCellText(String(value), { style, width: columnWidths[1] }),
          ],
        })
    ),
  });
}

function historyTable(style, versions) {
  const columnWidths = [0.1, 0.16, 0.28, 0.16, 0.3].map((fraction) => Math.round(TABLE_WIDTH_DXA * fraction));
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
  return documentsAssocies.map((name) => new Paragraph({ children: [new TextRun(`•  ${name}`)] }));
}

// Bandeau de couleur pleine largeur en tête de page 1 (option, désactivée par défaut) — un seul
// paragraphe teinté avant même le titre, hauteur pilotée par spacing avant/après (jamais une
// hauteur fixe en points) pour ne jamais décaler le contenu qui suit de façon imprévisible.
function bandParagraph(style) {
  return new Paragraph({ shading: { type: ShadingType.CLEAR, fill: hexColor(style.accentColor) }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: ' ' })] });
}

// Bloc titre de référence : "PROCÉDURE" centré, sous-titre en italique (numéro + titre réel) —
// un seul traitement, remplace l'ancien titleBlockParagraphs paramétré par thème (banner/
// centered-bold/plain).
function titleBlockParagraphs({ procedureNumber, procedureTitle }) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: 'PROCÉDURE', bold: true, size: BASE_FONT_SIZE + 12 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: `${procedureNumber} — ${procedureTitle}`, italics: true, size: BASE_FONT_SIZE + 4 })],
    }),
  ];
}

// Lit les dimensions réelles du logo (PNG/JPEG/WEBP/GIF — seuls formats acceptés à l'upload,
// voir routes/tenant.js#ALLOWED_LOGO_TYPES) pour calculer une largeur proportionnelle à une
// hauteur fixe, sans jamais déformer l'image (docx#ImageRun exige des dimensions explicites,
// il ne les déduit pas seul du buffer).
function logoImageRun(tenantLogo) {
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
    // services/procedurePdf.js pour le PDF).
    return null;
  }
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
export async function buildProcedureWordDocument({ accentColor, visualOptions, tenantLogo, procedure, version, versions }) {
  const style = resolveStyle({ accentColor, visualOptions });
  const content = version.content || {};
  const sections = content.sections || [];

  const body = [];

  if (style.band) {
    body.push(bandParagraph(style));
  }

  body.push(...titleBlockParagraphs({ procedureNumber: procedure.number, procedureTitle: procedure.title }));
  body.push(identityTable(style, { procedure, version }));
  body.push(new Paragraph({ text: '' }));

  // Le sommaire est un bloc de contenu comme un autre (voir le plan de refonte) : une section
  // portant la clé "sommaire" — typiquement en tête, ajoutée par défaut par l'éditeur (voir
  // frontend/src/lib/procedureBlocks.js#ensureSommaireSection) ou réécrite librement à la main —
  // est rendue par le walker ci-dessous SANS aucun traitement spécial, exactement comme
  // n'importe quelle autre section (donc jamais régénérée/écrasée automatiquement au rendu).
  // Repli UNIQUEMENT pour le contenu qui n'a encore aucune section "sommaire" explicite (contenu
  // migré depuis l'ancien format, ou tenant qui n'en a jamais ajouté) : un sommaire calculé à la
  // volée à partir de la structure réelle, comme avant cette évolution — jamais stocké, donc
  // jamais en décalage avec le contenu tant qu'aucune section "sommaire" n'existe.
  const hasSommaireSection = sections.some((s) => s.key === 'sommaire');
  if (!hasSommaireSection) {
    // Contrairement au PDF, Word ne connaît pas les numéros de page au moment de la génération
    // (la pagination réelle dépend du rendu chez le lecteur) : la liste reste donc sans numéro,
    // comme le sommaire de l'écran lui-même.
    const autoTocLabels = [
      ...sections.map((s) => s.label),
      content.documents_associes?.length > 0 && 'Documents associés',
      'Historique des versions',
    ].filter(Boolean);
    if (autoTocLabels.length >= 3) {
      body.push(sectionTitleParagraph('Sommaire'));
      autoTocLabels.forEach((label) => body.push(new Paragraph({ children: [new TextRun(`•  ${label}`)] })));
      body.push(new Paragraph({ text: '' }));
    }
  }

  // Saut de page avant le corps de la procédure : c'est la partie la plus longue du document,
  // la faire démarrer sur une page fraîche évite qu'elle s'enchaîne directement à la suite du
  // sommaire/tableau d'identité sans rupture visuelle.
  sections.forEach((section, index) => {
    body.push(sectionTitleParagraph(section.label, { pageBreakBefore: index === 0 }));
    body.push(...blocksToDocxParagraphs(section.blocks, style));
  });

  if (content.documents_associes?.length) {
    body.push(sectionTitleParagraph('Documents associés'));
    body.push(...documentsAssociesParagraphs(content.documents_associes));
  }

  // Sur sa propre page, même logique que le corps ci-dessus : une annexe de traçabilité mélangée
  // au texte qui précède se perdait visuellement plutôt que de se lire comme une section à part.
  body.push(sectionTitleParagraph('Historique des versions', { pageBreakBefore: true }));
  body.push(historyTable(style, versions));

  // Logo à gauche, référence document à droite — un seul paragraphe avec une tabulation
  // droite plutôt que deux cellules de tableau, pour rester au plus près du pied de page déjà
  // existant (simple Paragraph, pas de Table dans l'en-tête).
  const logo = logoImageRun(tenantLogo);
  const headerChildren = logo
    ? [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TABLE_WIDTH_DXA }],
          children: [logo, new TextRun({ text: `\t${procedure.number} — ${procedure.title}`, size: 16, color: '888888' })],
        }),
      ]
    : [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `${procedure.number} — ${procedure.title}`, size: 16, color: '888888' })],
        }),
      ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT_FAMILY, size: BASE_FONT_SIZE } } } },
    sections: [
      {
        headers: { default: new Header({ children: headerChildren }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: 'Page ', size: 16, color: '888888' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888' }),
                  new TextRun({ text: ' / ', size: 16, color: '888888' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '888888' }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
