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
} from 'docx';

// Un moteur de rendu commun paramétré par un "thème" par preset, plutôt que 4 fichiers
// dupliqués : les 4 styles diffèrent par des CHOIX (police, bandeau vs texte plat, puce "o" vs
// "-", libellé d'encadré, couleurs de tableau...), jamais par la STRUCTURE du document
// (en-tête/pied de page, tableau d'identité, sections numérotées, tableau d'historique) — voir
// data/procedureTemplatePresets.js pour la description d'origine de chaque style. Le style
// réellement actif d'un tenant est procedure_templates.active_preset_id (voir
// routes/procedureTemplates.js#apply-preset) ; DEFAULT_STYLE_ID sert de repli pour un tenant
// qui n'a jamais appliqué de preset (gabarit configuré à la main).
const DEFAULT_STYLE_ID = 'iso-generique';

const PROCEDURE_STATUS_LABELS = { draft: 'Brouillon', in_review: 'En revue', approved: 'Approuvé', obsolete: 'Obsolète' };
const VERSION_STATUS_LABELS = { draft: 'Brouillon', pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };

// Chaque entrée de calloutBySeverity dit à quoi ressemble l'encadré ("label"/"background"/
// "border") pour une sévérité donnée ('danger'/'warning'/'info' — voir la sévérité déjà
// choisie par l'IA dans services/groq.js). "background: null" = pas de remplissage (bordure
// seule), utilisé par iso-generique dont la consigne exige un rendu strictement noir et blanc.
const STYLE_THEMES = {
  'mtl-logistique': {
    fontFamily: 'Times New Roman',
    baseFontSize: 22,
    titleBlock: { type: 'centered-bold', text: 'PROCEDURE DU SYSTEME DE GESTION DE LA QUALITE' },
    sommaire: true,
    sectionTitle: { type: 'bold-plain' },
    subBulletMarker: 'o',
    calloutBySeverity: {
      danger: { label: 'Important', background: 'EDEDED', border: '000000' },
      warning: { label: 'Important', background: 'EDEDED', border: '000000' },
      info: { label: 'Important', background: 'EDEDED', border: '000000' },
    },
    tableHeader: { background: 'EDEDED', textColor: '000000' },
    accentColor: '000000',
    topDangerBanner: false,
  },
  'iso-generique': {
    fontFamily: 'Times New Roman',
    baseFontSize: 22,
    titleBlock: { type: 'plain', text: 'PROCÉDURE QUALITÉ' },
    sommaire: false,
    sectionTitle: { type: 'bold-plain' },
    subBulletMarker: '-',
    calloutBySeverity: {
      danger: { label: 'Attention', background: null, border: '000000' },
      warning: { label: 'Attention', background: null, border: '000000' },
      info: { label: 'Note', background: null, border: '000000' },
    },
    tableHeader: { background: 'F2F2F2', textColor: '000000' },
    accentColor: '000000',
    topDangerBanner: false,
  },
  'moderne-tertiaire': {
    fontFamily: 'Calibri',
    baseFontSize: 22,
    titleBlock: { type: 'banner', background: '2C5F8A', textColor: 'FFFFFF' },
    sommaire: false,
    sectionTitle: { type: 'left-border', color: '2C5F8A' },
    subBulletMarker: 'none',
    calloutBySeverity: {
      danger: { label: 'À retenir', background: 'EAF2FA', border: '2C5F8A' },
      warning: { label: 'À retenir', background: 'EAF2FA', border: '2C5F8A' },
      info: { label: 'À retenir', background: 'EAF2FA', border: '2C5F8A' },
    },
    tableHeader: { background: '2C5F8A', textColor: 'FFFFFF' },
    tableAltRow: 'EAF2FA',
    accentColor: '2C5F8A',
    topDangerBanner: false,
  },
  'industriel-securite': {
    fontFamily: 'Arial',
    baseFontSize: 24,
    titleBlock: { type: 'banner', background: '000000', textColor: 'F2A900' },
    sommaire: false,
    sectionTitle: { type: 'band', background: 'D9D9D9', textColor: '000000' },
    subBulletMarker: '-',
    calloutBySeverity: {
      danger: { label: 'DANGER', background: 'FDEBEA', border: 'B00000' },
      warning: { label: 'ATTENTION', background: 'FFF3E3', border: 'C1610B' },
      info: { label: 'ATTENTION', background: 'FFF3E3', border: 'C1610B' },
    },
    tableHeader: { background: 'D9D9D9', textColor: '000000' },
    accentColor: 'F2A900',
    topDangerBanner: true,
  },
};

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

function resolveCallout(theme, severity) {
  return theme.calloutBySeverity[severity] || theme.calloutBySeverity.info;
}

// Retire une numérotation que le modèle ajoute parfois lui-même malgré la consigne du prompt
// (voir services/procedureFullDraftJob.js#stripLeadingNumbering, même correctif appliqué ici
// indépendamment car ce renderer lit subsection.actions directement).
function stripLeadingNumbering(text) {
  return (text || '').replace(/^\s*\d+[.)]\s*/, '');
}

function borderLine(color, style = BorderStyle.SINGLE, size = 6) {
  return { style, size, color, space: 6 };
}

function boxParagraphs({ label, background, border, text }) {
  const borderSides = {
    top: borderLine(border),
    bottom: borderLine(border),
    left: borderLine(border),
    right: borderLine(border),
  };
  return [
    new Paragraph({
      border: borderSides,
      shading: background ? { type: ShadingType.CLEAR, fill: background } : undefined,
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({ text: `${label} : `, bold: true }),
        ...text.split('\n').flatMap((line, index) => (index === 0 ? [new TextRun(line)] : [new TextRun({ text: line, break: 1 })])),
      ],
    }),
  ];
}

function calloutParagraphs(theme, callout) {
  if (!callout) return [];
  const style = resolveCallout(theme, callout.severity);
  return boxParagraphs({ ...style, text: callout.text });
}

// Élément commun à tous les styles (voir spec) : chaque légende identifiée par l'IA
// (subsection.photo_placeholders, voir services/groq.js) devient un encadré en pointillés,
// pour que le rédacteur n'ait plus qu'à remplacer la zone par sa propre image dans Word.
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

function sectionTitleParagraph(theme, text) {
  const base = { text, bold: true, size: theme.baseFontSize + 2 };
  switch (theme.sectionTitle.type) {
    case 'left-border':
      return new Paragraph({
        spacing: { before: 200, after: 100 },
        border: { left: borderLine(theme.sectionTitle.color, BorderStyle.SINGLE, 24) },
        indent: { left: 120 },
        children: [new TextRun({ ...base, color: theme.sectionTitle.color })],
      });
    case 'band':
      return new Paragraph({
        spacing: { before: 200, after: 100 },
        shading: { type: ShadingType.CLEAR, fill: theme.sectionTitle.background },
        children: [new TextRun({ ...base, color: theme.sectionTitle.textColor })],
      });
    case 'bold-plain':
    default:
      return new Paragraph({ spacing: { before: 200, after: 100 }, children: [new TextRun(base)] });
  }
}

function subBulletParagraphs(theme, bullets) {
  return (bullets || []).map((bullet) => {
    const prefix = theme.subBulletMarker === 'o' ? 'o  ' : theme.subBulletMarker === '-' ? '-  ' : '';
    return new Paragraph({ indent: { left: 480 }, children: [new TextRun(`${prefix}${bullet}`)] });
  });
}

function actionParagraphs(theme, actions) {
  return (actions || []).flatMap((action, index) => [
    new Paragraph({ children: [new TextRun(`${index + 1}. ${stripLeadingNumbering(action.text)}`)] }),
    ...subBulletParagraphs(theme, action.sub_bullets),
  ]);
}

// Sous-section issue de generateProcedureComplete (voir services/procedureFullDraftJob.js) :
// titre, intro, actions numérotées, encadré éventuel, emplacements photo éventuels.
function subsectionParagraphs(theme, sectionNumber, index, subsection) {
  const heading = new Paragraph({
    spacing: { before: 160, after: 60 },
    children: [new TextRun({ text: `${sectionNumber}.${index + 1} ${subsection.title}`, bold: true })],
  });

  if (subsection.generation_status === 'failed') {
    return [
      heading,
      new Paragraph({
        children: [
          new TextRun({ text: 'À compléter manuellement — la génération automatique de cette sous-section a échoué.', italics: true, color: '888888' }),
        ],
      }),
    ];
  }

  return [
    heading,
    ...(subsection.intro ? [new Paragraph({ children: [new TextRun(subsection.intro)] })] : []),
    ...actionParagraphs(theme, subsection.actions),
    ...calloutParagraphs(theme, subsection.callout),
    ...(subsection.photo_placeholders || []).flatMap((caption) => photoPlaceholderParagraphs(caption)),
  ];
}

// Section sans sous-sections structurées (brouillon rapide généré par generateProcedureDraft,
// ou rédigé/édité à la main) : un seul bloc de texte à plat, même repli que
// services/procedurePdf.js#drawSubSection. Le titre de section est déjà posé par
// sectionTitleParagraph() côté appelant — cette fonction ne rend que le corps.
function flatSectionBodyParagraphs(section) {
  const bodyLines = (section.content || 'Non renseigné').split('\n');
  return bodyLines.map((line) => new Paragraph({ children: [new TextRun(line)] }));
}

function titleBlockParagraphs(theme, { procedureNumber, procedureTitle, tenantName }) {
  if (theme.titleBlock.type === 'banner') {
    return [
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: theme.titleBlock.background },
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 200 },
        children: [
          new TextRun({ text: `${procedureNumber} — ${procedureTitle}`, bold: true, size: theme.baseFontSize + 6, color: theme.titleBlock.textColor }),
        ],
      }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: tenantName || 'Entreprise', color: '666666' })] }),
    ];
  }

  return [
    new Paragraph({
      alignment: theme.titleBlock.type === 'centered-bold' ? AlignmentType.CENTER : AlignmentType.START,
      spacing: { after: 100 },
      children: [new TextRun({ text: theme.titleBlock.text, bold: true, size: theme.baseFontSize + 4 })],
    }),
    new Paragraph({
      alignment: theme.titleBlock.type === 'centered-bold' ? AlignmentType.CENTER : AlignmentType.START,
      spacing: { after: 200 },
      children: [new TextRun({ text: `${procedureNumber} — ${procedureTitle}`, bold: true })],
    }),
  ];
}

function tableCellText(text, { header, theme } = {}) {
  return new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: theme.tableHeader.background } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!header, color: header ? theme.tableHeader.textColor : undefined })] })],
  });
}

function identityTable(theme, { procedure, version }) {
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
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [tableCellText(label, { header: true, theme }), tableCellText(String(value), { theme })],
        })
    ),
  });
}

function historyTable(theme, versions) {
  const headerRow = new TableRow({
    children: ['Version', 'Statut', 'Rédigée par', 'Date', 'Validée par'].map((text) => tableCellText(text, { header: true, theme })),
  });
  const rows = (versions || []).map(
    (v) =>
      new TableRow({
        children: [
          tableCellText(`v${v.version}`, { theme }),
          tableCellText(VERSION_STATUS_LABELS[v.status] || v.status, { theme }),
          tableCellText(v.author?.full_name || 'auteur inconnu', { theme }),
          tableCellText(formatDate(v.created_at), { theme }),
          tableCellText(v.validator?.full_name || '—', { theme }),
        ],
      })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...rows] });
}

function documentsAssociesParagraphs(documentsAssocies) {
  if (!documentsAssocies?.length) return [];
  return documentsAssocies.map((name) => new Paragraph({ children: [new TextRun(`•  ${name}`)] }));
}

// Detecte un risque grave n'importe où dans le document généré (voir
// services/procedureFullDraftJob.js) — uniquement consommé par le style industriel-sécurité,
// dont la consigne exige un encadré DANGER visible dès l'ouverture du document plutôt que
// noyé au milieu de 15 pages.
function hasTopLevelDangerCallout(sections) {
  return (sections || []).some((section) =>
    (section.subsections || []).some((subsection) => subsection.callout?.severity === 'danger')
  );
}

export function findStyleTheme(presetId) {
  return STYLE_THEMES[presetId] || STYLE_THEMES[DEFAULT_STYLE_ID];
}

// content : procedure_versions.content (voir services/procedureFullDraftJob.js pour le format
// riche avec subsections, ou le format court de generateProcedureDraft — les deux sont
// supportés, section.subsections absent => repli sur flatSectionParagraphs). presetId :
// procedure_templates.active_preset_id du tenant (ou null => DEFAULT_STYLE_ID, voir
// findStyleTheme). procedure/version/versions : mêmes lignes que services/procedurePdf.js.
export async function buildProcedureWordDocument({ presetId, tenantName, procedure, version, versions }) {
  const theme = findStyleTheme(presetId);
  const content = version.content || {};
  const sections = content.sections || [];

  const body = [];
  body.push(...titleBlockParagraphs(theme, { procedureNumber: procedure.number, procedureTitle: procedure.title, tenantName }));

  if (theme.topDangerBanner && hasTopLevelDangerCallout(sections)) {
    body.push(
      ...boxParagraphs({
        ...resolveCallout(theme, 'danger'),
        text: "Cette procédure comporte au moins une étape à risque grave — voir les encadrés DANGER dans le déroulé ci-dessous.",
      })
    );
  }

  body.push(identityTable(theme, { procedure, version }));
  body.push(new Paragraph({ text: '' }));

  if (theme.sommaire) {
    body.push(new Paragraph({ spacing: { before: 100, after: 100 }, children: [new TextRun({ text: 'Sommaire', bold: true })] }));
    body.push(new Paragraph({ children: [new TextRun('•  Objet')] }));
    body.push(new Paragraph({ children: [new TextRun("•  Domaine d'application")] }));
    body.push(new Paragraph({ children: [new TextRun('•  Responsabilités')] }));
    sections.forEach((section) => body.push(new Paragraph({ children: [new TextRun(`•  ${section.label}`)] })));
    if (content.documents_associes?.length) body.push(new Paragraph({ children: [new TextRun('•  Documents associés')] }));
    body.push(new Paragraph({ children: [new TextRun('•  Historique des versions')] }));
  }

  body.push(sectionTitleParagraph(theme, '1. Objet'));
  body.push(new Paragraph({ children: [new TextRun(content.objet || 'Non renseigné')] }));
  body.push(sectionTitleParagraph(theme, "2. Domaine d'application"));
  body.push(new Paragraph({ children: [new TextRun(content.domaine_application || 'Non renseigné')] }));
  body.push(sectionTitleParagraph(theme, '3. Responsabilités'));
  body.push(new Paragraph({ children: [new TextRun(content.responsabilites || 'Non renseigné')] }));

  sections.forEach((section, index) => {
    const sectionNumber = `${index + 4}`;
    body.push(sectionTitleParagraph(theme, `${sectionNumber}. ${section.label}`));
    if (section.subsections?.length) {
      section.subsections.forEach((subsection, subIndex) => {
        body.push(...subsectionParagraphs(theme, sectionNumber, subIndex, subsection));
      });
    } else {
      body.push(...flatSectionBodyParagraphs(section));
    }
  });

  const documentsIndex = sections.length + 4;
  if (content.documents_associes?.length) {
    body.push(sectionTitleParagraph(theme, `${documentsIndex}. Documents associés`));
    body.push(...documentsAssociesParagraphs(content.documents_associes));
  }

  body.push(new Paragraph({ text: '' }));
  body.push(sectionTitleParagraph(theme, 'Historique des versions'));
  body.push(historyTable(theme, versions));

  const doc = new Document({
    styles: { default: { document: { run: { font: theme.fontFamily, size: theme.baseFontSize } } } },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: `${procedure.number} — ${procedure.title}`, size: 16, color: '888888' })],
              }),
            ],
          }),
        },
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
