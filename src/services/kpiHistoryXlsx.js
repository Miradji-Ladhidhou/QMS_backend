import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const INK_ARGB = 'FF1E293B';
const MUTED_ARGB = 'FF64748B';
const EXCEL_GREEN_ARGB = 'FF107C41';
const WHITE_ARGB = 'FFFFFFFF';
const SUBHEADER_FILL_ARGB = 'FFF1F5F9';
const LETTER_ROW_FILL_ARGB = 'FFE2E8F0';
const ROW_ALT_FILL_ARGB = 'FFF8FAFC';
const BORDER_ARGB = 'FFCBD5E1';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };

const SERIES_HEX_COLORS = ['1F3864', '0D9488', 'D97706', '7C3AED', 'DB2777', '2563EB', '059669', 'DC2626'];

function formatIsoDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function colIndexToLetter(col) {
  let temp = col;
  let letter = '';
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const SOURCE_LABELS = {
  manual: 'Saisie manuelle',
  import: 'Import Excel',
  module: 'Calcul automatique',
};

const FREQUENCY_LABELS = {
  daily: 'Quotidien',
  weekly: 'Hebdomadaire',
  monthly: 'Mensuel',
  quarterly: 'Trimestriel',
  yearly: 'Annuel',
};

/**
 * Génère le XML d'un graphique natif OpenXML (Line ou Bar)
 * branché directement sur les cellules réelles de la feuille de calcul.
 */
function buildChartXml({
  sheetName,
  chartTitle,
  chartType,
  categories,
  categoryRange,
  seriesList,
}) {
  const isBar = chartType === 'bar';

  const seriesXml = seriesList
    .map((s, idx) => {
      const color = s.color || SERIES_HEX_COLORS[idx % SERIES_HEX_COLORS.length];
      const titleFormula = `'${escapeXml(sheetName)}'!$${s.valColLetter}$4`;
      const valFormula = `'${escapeXml(sheetName)}'!$${s.valColLetter}$5:$${s.valColLetter}$${s.lastRow}`;
      const catFormula = `'${escapeXml(sheetName)}'!${categoryRange}`;

      if (isBar) {
        return `
        <c:ser>
          <c:idx val="${idx}"/>
          <c:order val="${idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>${titleFormula}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>${escapeXml(s.label)}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
            <a:ln w="9525">
              <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
            </a:ln>
          </c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>${catFormula}</c:f>
              <c:strCache>
                <c:ptCount val="${categories.length}"/>
                ${categories.map((c, i) => `<c:pt idx="${i}"><c:v>${escapeXml(c)}</c:v></c:pt>`).join('')}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${valFormula}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="${s.values.length}"/>
                ${s.values.map((v, i) => `<c:pt idx="${i}"><c:v>${v !== null && v !== undefined && !Number.isNaN(v) ? v : ''}</c:v></c:pt>`).join('')}
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>`;
      }

      // Line chart
      return `
        <c:ser>
          <c:idx val="${idx}"/>
          <c:order val="${idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>${titleFormula}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>${escapeXml(s.label)}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:ln w="25400">
              <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
            </a:ln>
          </c:spPr>
          <c:marker>
            <c:symbol val="circle"/>
            <c:size val="5"/>
            <c:spPr>
              <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
              <a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln>
            </c:spPr>
          </c:marker>
          <c:cat>
            <c:strRef>
              <c:f>${catFormula}</c:f>
              <c:strCache>
                <c:ptCount val="${categories.length}"/>
                ${categories.map((c, i) => `<c:pt idx="${i}"><c:v>${escapeXml(c)}</c:v></c:pt>`).join('')}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${valFormula}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="${s.values.length}"/>
                ${s.values.map((v, i) => `<c:pt idx="${i}"><c:v>${v !== null && v !== undefined && !Number.isNaN(v) ? v : ''}</c:v></c:pt>`).join('')}
              </c:numCache>
            </c:numRef>
          </c:val>
          <c:smooth val="0"/>
        </c:ser>`;
    })
    .join('');

  const chartBody = isBar
    ? `
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        ${seriesXml}
        <c:gapWidth val="150"/>
        <c:axId val="148921104"/>
        <c:axId val="148922640"/>
      </c:barChart>`
    : `
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        ${seriesXml}
        <c:axId val="148921104"/>
        <c:axId val="148922640"/>
      </c:lineChart>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:lang val="fr-FR"/>
  <c:chart>
    <c:title>
      <c:tx>
        <c:rich>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:pPr><a:defRPr sz="1200" b="1"/></a:pPr>
            <a:r>
              <a:rPr lang="fr-FR"/>
              <a:t>${escapeXml(chartTitle)}</a:t>
            </a:r>
          </a:p>
        </c:rich>
      </c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:plotArea>
      <c:layout/>
      ${chartBody}
      <c:catAx>
        <c:axId val="148921104"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:majorTickMark val="none"/>
        <c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="148922640"/>
        <c:crosses val="autoZero"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="148922640"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:majorGridlines>
          <c:spPr>
            <a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln>
          </c:spPr>
        </c:majorGridlines>
        <c:numFmt formatCode="General" sourceLinked="1"/>
        <c:majorTickMark val="none"/>
        <c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="148921104"/>
        <c:crosses val="autoZero"/>
        <c:crossBetween val="between"/>
      </c:valAx>
    </c:plotArea>
    <c:legend>
      <c:legendPos val="b"/>
      <c:layout/>
      <c:overlay val="0"/>
    </c:legend>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
    <c:showDLblsOverMax val="0"/>
  </c:chart>
</c:chartSpace>`;
}

/**
 * Injecte le graphique natif OpenXML dans le classeur Excel via JSZip
 */
async function injectNativeChartIntoZip(baseBuffer, chartConfig) {
  const zip = await JSZip.loadAsync(baseBuffer);

  // Trouver le chemin exact de la feuille de calcul
  const sheetPath = Object.keys(zip.files).find(
    (p) => p.startsWith('xl/worksheets/sheet') && p.endsWith('.xml') && !p.includes('_rels')
  ) || 'xl/worksheets/sheet1.xml';

  const sheetFilename = sheetPath.split('/').pop();
  const sheetRelsPath = `xl/worksheets/_rels/${sheetFilename}.rels`;

  const chartXml = buildChartXml(chartConfig);

  const { fromCol, toCol, fromRow, toRow } = chartConfig.placement;

  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from>
      <xdr:col>${fromCol}</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${fromRow}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>${toCol}</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${toRow}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Graphique 1"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm>
        <a:off x="0" y="0"/>
        <a:ext cx="0" cy="0"/>
      </xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart r:id="rIdChart1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;

  const drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`;

  // 1. Enregistrer chart1.xml, drawing1.xml et drawing1.xml.rels
  zip.file('xl/charts/chart1.xml', chartXml);
  zip.file('xl/drawings/drawing1.xml', drawingXml);
  zip.file('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml);

  // 2. Lier drawing1.xml dans la feuille de calcul
  let sheetRelsXml = '';
  if (zip.file(sheetRelsPath)) {
    sheetRelsXml = await zip.file(sheetRelsPath).async('string');
    if (!sheetRelsXml.includes('Target="../drawings/drawing1.xml"')) {
      sheetRelsXml = sheetRelsXml.replace(
        '</Relationships>',
        '<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
      );
    }
  } else {
    sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
  }
  zip.file(sheetRelsPath, sheetRelsXml);

  // 3. Ajouter <drawing r:id="rIdDrawing1"/> dans le XML de la feuille
  let sheetXml = await zip.file(sheetPath).async('string');
  if (!sheetXml.includes('<drawing')) {
    sheetXml = sheetXml.replace(
      '</worksheet>',
      '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdDrawing1"/></worksheet>'
    );
    zip.file(sheetPath, sheetXml);
  }

  // 4. Déclarer les types de contenu dans [Content_Types].xml
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  if (!contentTypes.includes('/xl/charts/chart1.xml')) {
    contentTypes = contentTypes.replace(
      '</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'
    );
    zip.file('[Content_Types].xml', contentTypes);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Génère un classeur Excel respectant exactement la présentation du « Tableur historique »
 * affiché à l'écran :
 * - Bandeau titre Excel vert
 * - Métadonnées du KPI (organisation, cible, fréquence, date d'export)
 * - Ligne de repères de colonnes (#, A, B, C...)
 * - En-têtes de colonnes répliquant exactement la table web
 * - Colonne Ligne numérotée (1, 2, 3...)
 * - Données formatées (dates JJ/MM/AAAA, valeurs avec unité, source, commentaire, saisie par)
 * - Support mono-série et multi-séries (matrice par période)
 * - En-têtes figés et filtres automatiques natifs Excel
 * - Graphique NATIF Excel généré à partir des données réelles de la feuille
 */
export async function buildKpiHistoryXlsx({ kpi, records, tenantName, exportedBy, chartType = 'line' }) {
  const workbook = new ExcelJS.Workbook();
  const sheetTitle = (kpi.name || 'Historique').replace(/[\\/?*[\]]/g, '').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetTitle);

  const seriesConfigs = kpi.calculation_configs || [];
  const showSeriesColumn = seriesConfigs.length > 1;
  const isImportBased = kpi.calculation_type === 'import';
  const labelByConfigId = Object.fromEntries(seriesConfigs.map((c) => [c.id, c.label]));

  // Récupération de l'unité
  const defaultUnit = kpi.unit || '';

  // Définition des colonnes selon mono-série vs multi-séries
  let columnsDef = [];
  if (showSeriesColumn) {
    columnsDef = [
      { key: 'line', label: 'Ligne', width: 9, align: 'center' },
      { key: 'period_date', label: 'Période', width: 14, align: 'center' },
    ];
    seriesConfigs.forEach((series) => {
      const unit = series.unit || defaultUnit;
      columnsDef.push({
        key: `val_${series.id}`,
        label: `${series.label}${unit ? ` (${unit})` : ''}`,
        width: 18,
        align: 'right',
      });
      columnsDef.push({
        key: `com_${series.id}`,
        label: `Commentaire ${series.label}`,
        width: 25,
        align: 'left',
      });
    });
  } else {
    columnsDef = [
      { key: 'line', label: 'Ligne', width: 9, align: 'center' },
      { key: 'period_date', label: 'Période', width: 14, align: 'center' },
      { key: 'value', label: `Valeur${defaultUnit ? ` (${defaultUnit})` : ''}`, width: 16, align: 'right' },
    ];
    if (isImportBased) {
      columnsDef.push({ key: 'source', label: 'Source', width: 18, align: 'left' });
    }
    columnsDef.push(
      { key: 'comment', label: 'Commentaire', width: 35, align: 'left' },
      { key: 'recorded_by', label: 'Saisi par', width: 22, align: 'left' }
    );
  }

  sheet.columns = columnsDef.map((c) => ({ width: c.width }));
  const totalCols = columnsDef.length;

  // Ligne 1 : Titre principal (Bandeau vert Excel)
  const titleRow = sheet.getRow(1);
  titleRow.getCell(1).value = `Tableur historique — ${kpi.name}`;
  sheet.mergeCells(1, 1, 1, totalCols);
  titleRow.getCell(1).font = { bold: true, size: 13, color: { argb: WHITE_ARGB } };
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_GREEN_ARGB } };
  titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleRow.height = 26;
  titleRow.commit();

  // Ligne 2 : Métadonnées
  const metaParts = [];
  if (tenantName) metaParts.push(`Entreprise : ${tenantName}`);
  if (kpi.target !== null && kpi.target !== undefined) {
    const dir = kpi.target_direction === 'max' ? '≤' : '≥';
    metaParts.push(`Objectif : ${dir} ${kpi.target} ${defaultUnit}`.trim());
  }
  if (kpi.frequency) metaParts.push(`Fréquence : ${FREQUENCY_LABELS[kpi.frequency] || kpi.frequency}`);
  metaParts.push(`${records.length} relevé${records.length > 1 ? 's' : ''}`);
  metaParts.push(`Exporté le ${new Date().toLocaleDateString('fr-FR')} par ${exportedBy || 'Utilisateur'}`);

  const metaRow = sheet.getRow(2);
  metaRow.getCell(1).value = metaParts.join('   |   ');
  sheet.mergeCells(2, 1, 2, totalCols);
  metaRow.getCell(1).font = { italic: true, size: 9.5, color: { argb: MUTED_ARGB } };
  metaRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } };
  metaRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  metaRow.height = 18;
  metaRow.commit();

  // Ligne 3 : Repère alphabétique Excel (#, A, B, C...)
  const letterRowNumber = 3;
  const letterRow = sheet.getRow(letterRowNumber);
  letterRow.getCell(1).value = '#';
  letterRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  letterRow.getCell(1).font = { size: 9, bold: true, color: { argb: MUTED_ARGB } };
  letterRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
  letterRow.getCell(1).border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

  for (let c = 2; c <= totalCols; c += 1) {
    const cell = letterRow.getCell(c);
    cell.value = String.fromCharCode(65 + c - 2);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.font = { size: 9, bold: true, color: { argb: MUTED_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  }
  letterRow.height = 16;
  letterRow.commit();

  // Ligne 4 : En-têtes de colonnes réels
  const headerRowNumber = 4;
  const headerRow = sheet.getRow(headerRowNumber);
  columnsDef.forEach((col, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = col.label;
    cell.alignment = {
      horizontal: col.align === 'right' ? 'right' : col.align === 'center' ? 'center' : 'left',
      vertical: 'middle',
    };
    cell.font = { bold: true, size: 10, color: { argb: INK_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  });
  headerRow.height = 22;
  headerRow.commit();

  // Lignes de données — triées par period_date asc (ordre chronologique des saisies)
  const sortedRecords = [...records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));

  let currentRowNumber = 5;
  const categories = [];
  const seriesValuesMap = new Map(); // seriesKey -> array of values

  if (showSeriesColumn) {
    // Regroupement par période pour le cas multi-séries
    const recordsByPeriod = new Map();
    sortedRecords.forEach((record) => {
      if (!recordsByPeriod.has(record.period_date)) recordsByPeriod.set(record.period_date, []);
      recordsByPeriod.get(record.period_date).push(record);
    });

    seriesConfigs.forEach((series) => {
      seriesValuesMap.set(series.id, []);
    });

    let rowIdx = 1;
    recordsByPeriod.forEach((periodRecords, period) => {
      const row = sheet.getRow(currentRowNumber);
      const isAlt = rowIdx % 2 === 0;
      const rowFill = isAlt
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE_ARGB } };

      const formattedPeriod = formatIsoDate(period);
      categories.push(formattedPeriod);

      // Colonne Ligne
      const lineCell = row.getCell(1);
      lineCell.value = rowIdx;
      lineCell.alignment = { horizontal: 'center', vertical: 'middle' };
      lineCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      lineCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
      lineCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Période
      const periodCell = row.getCell(2);
      periodCell.value = formattedPeriod;
      periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
      periodCell.font = { size: 10, color: { argb: INK_ARGB } };
      periodCell.fill = rowFill;
      periodCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonnes de chaque série
      let colIdx = 3;
      seriesConfigs.forEach((series) => {
        const item = periodRecords.find((r) => r.config_id === series.id);
        const val = item ? item.value : null;
        seriesValuesMap.get(series.id).push(val);

        const valCell = row.getCell(colIdx);
        valCell.value = val;
        valCell.alignment = { horizontal: 'right', vertical: 'middle' };
        valCell.font = { size: 10, bold: true, color: { argb: INK_ARGB } };
        valCell.fill = rowFill;
        valCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
        if (typeof val === 'number') valCell.numFmt = '#,##0.00';

        const comCell = row.getCell(colIdx + 1);
        comCell.value = item?.comment || null;
        comCell.alignment = { horizontal: 'left', vertical: 'middle' };
        comCell.font = { size: 9.5, color: { argb: INK_ARGB } };
        comCell.fill = rowFill;
        comCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

        colIdx += 2;
      });

      row.height = 20;
      row.commit();
      currentRowNumber += 1;
      rowIdx += 1;
    });
  } else {
    seriesValuesMap.set('single', []);

    sortedRecords.forEach((record, index) => {
      const row = sheet.getRow(currentRowNumber);
      const isAlt = (index + 1) % 2 === 0;
      const rowFill = isAlt
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE_ARGB } };

      const formattedPeriod = formatIsoDate(record.period_date);
      categories.push(formattedPeriod);
      seriesValuesMap.get('single').push(record.value);

      // Colonne Ligne (#)
      const lineCell = row.getCell(1);
      lineCell.value = index + 1;
      lineCell.alignment = { horizontal: 'center', vertical: 'middle' };
      lineCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      lineCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
      lineCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Période
      const periodCell = row.getCell(2);
      periodCell.value = formattedPeriod;
      periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
      periodCell.font = { size: 10, color: { argb: INK_ARGB } };
      periodCell.fill = rowFill;
      periodCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Valeur
      const valCell = row.getCell(3);
      valCell.value = record.value;
      valCell.alignment = { horizontal: 'right', vertical: 'middle' };
      valCell.font = { size: 10, bold: true, color: { argb: INK_ARGB } };
      valCell.fill = rowFill;
      valCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      if (typeof record.value === 'number') valCell.numFmt = '#,##0.00';

      let currentColIdx = 4;
      if (isImportBased) {
        const sourceCell = row.getCell(currentColIdx);
        sourceCell.value = SOURCE_LABELS[record.source] || record.source || '';
        sourceCell.alignment = { horizontal: 'left', vertical: 'middle' };
        sourceCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
        sourceCell.fill = rowFill;
        sourceCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
        currentColIdx += 1;
      }

      // Commentaire
      const commentCell = row.getCell(currentColIdx);
      commentCell.value = record.comment || null;
      commentCell.alignment = { horizontal: 'left', vertical: 'middle' };
      commentCell.font = { size: 9.5, color: { argb: INK_ARGB } };
      commentCell.fill = rowFill;
      commentCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      currentColIdx += 1;

      // Saisi par
      const recordedByCell = row.getCell(currentColIdx);
      recordedByCell.value = record.recorded_by_user?.full_name || null;
      recordedByCell.alignment = { horizontal: 'left', vertical: 'middle' };
      recordedByCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      recordedByCell.fill = rowFill;
      recordedByCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      row.height = 20;
      row.commit();
      currentRowNumber += 1;
    });
  }

  // Figer les lignes d'en-tête (lignes 1 à 4 figées lors du défilement)
  sheet.views = [{ state: 'frozen', ySplit: 4 }];

  // Filtres automatiques sur les colonnes du tableau
  if (currentRowNumber > 5) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: currentRowNumber - 1, column: totalCols },
    };
  }

  // Colonne de séparation (vide) à côté du tableau
  const spacerCol = totalCols + 1;
  sheet.getColumn(spacerCol).width = 4;

  const baseBuffer = await workbook.xlsx.writeBuffer();

  // Si au moins un relevé est présent, générer et injecter le graphique natif
  const dataRowCount = currentRowNumber - 5;
  if (dataRowCount >= 1) {
    const lastRow = currentRowNumber - 1;
    const categoryRange = `$B$5:$B$${lastRow}`;

    let seriesList = [];
    if (showSeriesColumn) {
      seriesList = seriesConfigs.map((series, sIdx) => {
        const valColLetter = colIndexToLetter(3 + sIdx * 2);
        return {
          label: series.label,
          valColLetter,
          lastRow,
          values: seriesValuesMap.get(series.id) || [],
          color: SERIES_HEX_COLORS[sIdx % SERIES_HEX_COLORS.length],
        };
      });
    } else {
      seriesList = [
        {
          label: kpi.name || 'Valeur',
          valColLetter: 'C',
          lastRow,
          values: seriesValuesMap.get('single') || [],
          color: '1F3864',
        },
      ];
    }

    let targetDesc = '';
    if (kpi.target !== null && kpi.target !== undefined) {
      const dir = kpi.target_direction === 'max' ? '≤' : '≥';
      targetDesc = ` (Objectif : ${dir} ${kpi.target} ${defaultUnit})`.trim();
    }

    const chartTitle = `Évolution — ${kpi.name}${targetDesc}`;

    // Emplacement à côté du tableau (0-indexed pour OpenXML: col totalCols + 1)
    const fromCol = totalCols + 1; // Col après le spacer
    const toCol = fromCol + 11; // Largeur d'environ 11 colonnes
    const fromRow = 3; // Ligne 4 (en face de l'en-tête)
    const toRow = Math.max(20, 4 + dataRowCount + 1); // Hauteur adaptée

    try {
      return await injectNativeChartIntoZip(baseBuffer, {
        sheetName: sheetTitle,
        chartTitle,
        chartType,
        categories,
        categoryRange,
        seriesList,
        placement: { fromCol, toCol, fromRow, toRow },
      });
    } catch (err) {
      console.warn("Erreur lors de l'injection du graphique natif Excel :", err);
      return baseBuffer;
    }
  }

  return baseBuffer;
}
