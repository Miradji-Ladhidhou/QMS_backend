import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que qqoqccpPdf.js/kpiReportPdf.js pour une identité visuelle cohérente entre
// les rapports PDF de l'application — dupliquées plutôt qu'importées, ces services n'ont pas
// d'autre couplage.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';
const INK = '#1e293b';
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

function drawPageHeader(doc, tenantName, tenantLogo, procedure, accentColor) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(accentColor);
  doc.fillColor('#ffffff').fontSize(16).text(`${procedure.number} — ${procedure.title}`, PAGE_MARGIN, 22, { width: CONTENT_WIDTH - 60 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 50, 18, { fit: [50, 50], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
}

// Même esprit que les encadrés "Important" d'un gabarit de procédure imprimé : un bandeau de
// couleur qui saute aux yeux, réservé à une information déjà réellement affichée à l'écran
// (bannière d'obsolescence sur ProcedureDetail.jsx, indicateur de retard sur Procedures.jsx) —
// jamais un contenu inventé pour l'occasion.
function drawImportantBox(doc, { color, background, label, text }) {
  doc.moveDown(0.3);
  const boxTop = doc.y;
  const height = doc.heightOfString(text, { width: CONTENT_WIDTH - 16 }) + 30;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).fill(background);
  doc.fontSize(9).fillColor(color).text(label, PAGE_MARGIN + 8, boxTop + 8, { width: CONTENT_WIDTH - 16 });
  doc.fontSize(9).fillColor(INK).text(text, PAGE_MARGIN + 8, doc.y + 2, { width: CONTENT_WIDTH - 16 });
  doc.y = boxTop + height + 10;
}

function drawNumberedSection(doc, number, title, body, accentColor) {
  doc.fontSize(11).fillColor(accentColor).text(`${number}. ${title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.2);
  if (body) {
    doc.fontSize(10).fillColor(INK).text(body, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  } else {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.7);
}

function drawSubSection(doc, number, title, body, accentColor) {
  doc.fontSize(10.5).fillColor(accentColor).text(`${number} ${title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.2);
  if (body) {
    doc.fontSize(10).fillColor(INK).text(body, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  } else {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.7);
}

// Le modèle préfixe parfois lui-même action.text par une numérotation malgré la consigne du
// prompt (voir services/procedureFullDraftJob.js#stripLeadingNumbering, même correctif
// appliqué ici indépendamment car ce renderer lit subsection.actions directement, pas le texte
// à plat déjà nettoyé de section.content).
function stripLeadingNumbering(text) {
  return (text || '').replace(/^\s*\d+[.)]\s*/, '');
}

// Sévérité -> couleurs. danger/warning restent FIXES (rouge/ambre) quel que soit le gabarit du
// tenant : ce sont des couleurs d'alerte sécurité/conformité, pas un choix de style — les
// presets eux-mêmes ne définissent d'ailleurs qu'UNE seule paire boxBackground/boxBorder, pas
// une par sévérité (voir data/procedureTemplatePresets.js). Seule la sévérité "info" (le
// simple "Important :"/"Note :"/"À retenir" neutre) reflète le style du tenant.
function calloutStyles(infoBoxStyle) {
  return {
    danger: { color: RED, background: RED_LIGHT, label: 'DANGER' },
    warning: { color: AMBER, background: AMBER_LIGHT, label: 'ATTENTION' },
    info: { color: infoBoxStyle.border, background: infoBoxStyle.background, label: 'IMPORTANT' },
  };
}

// Rendu d'une section issue du pipeline de génération complète (voir
// services/procedureFullDraftJob.js) : contrairement à drawSubSection ci-dessus (un seul bloc
// de texte plat), chaque sous-section du plan est rendue individuellement avec son propre
// encadré coloré si elle porte un callout — plutôt que de laisser le callout fondu dans le
// texte plat de section.content.
function drawGeneratedSection(doc, sectionNumber, sectionLabel, subsections, accentColor, infoBoxStyle) {
  const styles = calloutStyles(infoBoxStyle);
  doc.fontSize(11).fillColor(accentColor).text(`${sectionNumber}. ${sectionLabel}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.4);

  subsections.forEach((subsection, index) => {
    doc
      .fontSize(10.5)
      .fillColor(accentColor)
      .text(`${sectionNumber}.${index + 1} ${subsection.title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.2);

    if (subsection.generation_status === 'failed') {
      doc
        .fontSize(10)
        .fillColor(MUTED)
        .text('À compléter manuellement — la génération automatique de cette sous-section a échoué.', PAGE_MARGIN, doc.y, {
          width: CONTENT_WIDTH,
        });
      doc.moveDown(0.7);
      return;
    }

    if (subsection.intro) {
      doc.fontSize(10).fillColor(INK).text(subsection.intro, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
    }

    (subsection.actions || []).forEach((action, actionIndex) => {
      doc
        .fontSize(10)
        .fillColor(INK)
        .text(`${actionIndex + 1}. ${stripLeadingNumbering(action.text)}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      (action.sub_bullets || []).forEach((bullet) => {
        doc.fontSize(9.5).fillColor(INK).text(`•  ${bullet}`, PAGE_MARGIN + 14, doc.y, { width: CONTENT_WIDTH - 14 });
      });
    });
    doc.moveDown(0.3);

    if (subsection.callout) {
      const style = styles[subsection.callout.severity] || styles.info;
      drawImportantBox(doc, { ...style, text: subsection.callout.text });
    }

    doc.moveDown(0.4);
  });
}

// procedure : ligne procedures (avec obsoleted_by_user résolu). version : la version dont le
// contenu est imprimé — l'appelant choisit laquelle (voir routes/procedures.js#pdf : la
// courante si elle existe, sinon la plus récente, jamais un blocage tant qu'AU MOINS une
// version existe). versions : historique complet (author/validator résolus), pour le tableau
// en bas de document. renderStyle : procedure_templates.render_style du tenant ({accentColor,
// boxBackground, boxBorder, fontFamily} — voir data/procedureTemplatePresets.js), ou null/
// undefined si non configuré. Seuls accentColor/boxBackground/boxBorder sont appliqués ici :
// fontFamily reste hors périmètre, tous les exports PDF de l'app partagent la même police
// Unicode-safe (voir pdfFonts.js) et il n'existe aucun mécanisme de police par tenant.
// Calculé en variables LOCALES (jamais en constante de module) : plusieurs requêtes de tenants
// différents peuvent s'exécuter en concurrence dans le même process Node, une couleur globale
// mutable ferait fuiter le thème d'un tenant vers le PDF d'un autre.
export function buildProcedurePdf({ tenantName, tenantLogo, procedure, version, versions, renderStyle }) {
  const accentColor = renderStyle?.accentColor || NAVY;
  const infoBoxStyle = { background: renderStyle?.boxBackground || NAVY_LIGHT, border: renderStyle?.boxBorder || NAVY };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo, procedure, accentColor));

    drawPageHeader(doc, tenantName, tenantLogo, procedure, accentColor);

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

    doc.moveDown(0.5);
    drawNumberedSection(doc, 1, 'Objet', version.content?.objet, accentColor);
    drawNumberedSection(doc, 2, "Domaine d'application", version.content?.domaine_application, accentColor);
    drawNumberedSection(doc, 3, 'Responsabilités', version.content?.responsabilites, accentColor);

    const sections = version.content?.sections || [];
    if (sections.length > 0) {
      doc.fontSize(11).fillColor(accentColor).text('4. Contenu de la procédure', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);
      sections.forEach((section, index) => {
        if (section.subsections?.length) {
          drawGeneratedSection(doc, `4.${index + 1}`, section.label, section.subsections, accentColor, infoBoxStyle);
        } else {
          drawSubSection(doc, `4.${index + 1}`, section.label, section.content, accentColor);
        }
      });
    }

    const documentsAssocies = version.content?.documents_associes || [];
    if (documentsAssocies.length > 0) {
      doc
        .fontSize(11)
        .fillColor(accentColor)
        .text(`${sections.length > 0 ? 5 : 4}. Documents associés`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.2);
      documentsAssocies.forEach((name) => {
        doc.fontSize(10).fillColor(INK).text(`•  ${name}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.moveDown(0.15);
      });
      doc.moveDown(0.5);
    }

    // Historique des versions en bas de document — traçabilité qualité, même esprit que le
    // tableau "Historique des versions" déjà affiché sur ProcedureDetail.jsx.
    doc.moveDown(0.3);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(GRID).lineWidth(0.5).stroke();
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor(accentColor).text('Historique des versions', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.4);

    (versions || []).forEach((v) => {
      doc.fontSize(9.5).fillColor(INK).text(`v${v.version} — ${VERSION_STATUS_LABELS[v.status] || v.status}`, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        continued: false,
      });
      const authorLine = `Rédigée par ${v.author?.full_name || 'auteur inconnu'} le ${formatDate(v.created_at)}`;
      const validatorLine = v.validator?.full_name
        ? ` — ${v.status === 'rejected' ? 'Rejetée' : 'Validée'} par ${v.validator.full_name} le ${formatDate(v.validated_at)}`
        : '';
      doc.fontSize(8.5).fillColor(MUTED).text(authorLine + validatorLine, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.5);
    });

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
