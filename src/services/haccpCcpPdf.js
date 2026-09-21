import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, drawLetterheadHeader } from './pdfTheme.js';
import { CONTENT_WIDTH, PAGE_MARGIN, PAGE_WIDTH, drawTable, ensureSpace } from './pdfSimpleTable.js';
import { describeLimits } from './haccpMonitoring.js';
import { formatRiskDateTime } from './riskLabels.js';

const GOOD = '#047857';
const BAD = '#b91c1c';

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 70);
  doc.moveDown(0.6);
  doc.font('Body-Bold').fontSize(12).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

function drawParagraph(doc, text) {
  doc.fontSize(10).fillColor(text ? INK : MUTED).text(text || 'Non renseigné.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
}

// Fiche d'un point critique : définition complète (limites, surveillance, actions correctives, vérification,
// enregistrements), synthèse des relevés sur la période et derniers relevés. Sert de référence sur le terrain
// et de pièce d'audit. ccp : ligne enrichie (plan, étape, danger, responsable, limits) ; logs : plus récents d'abord.
export function buildHaccpCcpPdf({ ccp, stats, logs, days, tenantName, tenantLogo, tenantTimezone }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const label = ccp.ccp_number ? `CCP ${ccp.ccp_number}` : 'Point critique';
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `${label} — ${ccp.plan.title}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(16).fillColor(INK).text(`${label} — ${ccp.hazard_description}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.6);

    drawTable(doc, [{ width: 0.3 }, { width: 0.7 }], ['Information', 'Valeur'], [
      ['Plan', ccp.plan.title],
      ['Étape', `${ccp.step_number}. ${ccp.step_name}`],
      ['Limites critiques', ccp.critical_limits],
      ['Limites chiffrées', ccp.limits_text || 'Non définies (verdict saisi à la main)'],
      ['Fréquence de surveillance', ccp.monitoring_frequency || '—'],
      ['Rappel de relevé', ccp.monitoring_interval_hours ? `toutes les ${Number(ccp.monitoring_interval_hours)} h` : 'Aucun'],
      ['Responsable', ccp.monitoring_responsible_user?.full_name || 'À désigner'],
    ].map(([a, b]) => [{ text: a, bold: true }, { text: b }]));

    drawSectionTitle(doc, 'Procédure de surveillance');
    drawParagraph(doc, ccp.monitoring_procedure);
    drawSectionTitle(doc, 'Actions correctives prévues');
    drawParagraph(doc, ccp.corrective_action_procedure);
    drawSectionTitle(doc, 'Vérification');
    drawParagraph(doc, [ccp.verification_procedure, ccp.verification_frequency ? `Fréquence : ${ccp.verification_frequency}` : ''].filter(Boolean).join('\n'));
    drawSectionTitle(doc, 'Enregistrements à conserver');
    drawParagraph(doc, ccp.record_keeping_procedure);

    drawSectionTitle(doc, `Synthèse des relevés (${days} derniers jours)`);
    if (stats.total === 0) {
      drawParagraph(doc, 'Aucun relevé sur la période.');
    } else {
      drawTable(doc, [{ width: 0.4 }, { width: 0.6 }], ['Indicateur', 'Valeur'], [
        ['Relevés', String(stats.total)],
        ['Conformes / hors limites', `${stats.within} / ${stats.out}`],
        ['Taux de conformité', `${stats.conformity_percent} %`],
        ...(stats.average !== null ? [['Valeur moyenne (min – max)', `${stats.average}${ccp.limit_unit ? ` ${ccp.limit_unit}` : ''} (${stats.min} – ${stats.max})`]] : []),
        ...(ccp.limits_text ? [['Limites de référence', ccp.limits_text]] : []),
      ].map(([a, b]) => [{ text: a, bold: true }, { text: b, color: a === 'Taux de conformité' ? (stats.out === 0 ? GOOD : BAD) : undefined }]));
    }

    drawSectionTitle(doc, `Derniers relevés (${logs.length})`);
    if (logs.length === 0) {
      drawParagraph(doc, 'Aucun relevé.');
    } else {
      drawTable(
        doc,
        [{ width: 0.2 }, { width: 0.14 }, { width: 0.17 }, { width: 0.31 }, { width: 0.18 }],
        ['Date', 'Valeur', 'Verdict', 'Action corrective', 'Par'],
        logs.map((log) => [
          { text: formatRiskDateTime(log.recorded_at, tenantTimezone) },
          { text: log.recorded_value },
          { text: log.within_limits ? 'Conforme' : 'Hors limites', bold: true, color: log.within_limits ? GOOD : BAD },
          { text: log.corrective_action_taken || '' },
          { text: log.recorded_by_user?.full_name || '' },
        ])
      );
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Fiche point critique  ·  Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, { width: CONTENT_WIDTH, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}

export { describeLimits };
