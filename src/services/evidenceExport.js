import { AlignmentType, ImageRun, Paragraph, TextRun } from 'docx';
import imageSize from 'image-size';

const INK = '1E293B';
const MUTED = '64748B';

export function appendEvidenceToPdf(doc, evidence = [], { marginX, contentWidth }) {
  if (evidence.length === 0) return;
  doc.addPage();
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text('Annexe — Photos de preuve', marginX, doc.y, { width: contentWidth });
  doc.font('Body');
  doc.moveDown(0.5);

  const columnGap = 16;
  const columnWidth = (contentWidth - columnGap) / 2;
  const imageHeight = 190;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  for (let index = 0; index < evidence.length; index += 2) {
    const row = evidence.slice(index, index + 2);
    const captions = row.map((item, column) => `${index + column + 1}. ${item.caption || item.file_name}`);
    doc.font('Body').fontSize(9);
    const captionHeight = Math.max(...captions.map((caption) => doc.heightOfString(caption, { width: columnWidth })));
    const rowHeight = imageHeight + 8 + captionHeight + 18;
    if (doc.y + rowHeight > pageBottom()) doc.addPage();
    const rowY = doc.y;
    row.forEach((item, column) => {
      const x = marginX + column * (columnWidth + columnGap);
      doc.image(item.buffer, x, rowY, {
        fit: [columnWidth, imageHeight],
        align: 'center',
        valign: 'center',
      });
      doc.font('Body').fontSize(9).fillColor(INK).text(captions[column], x, rowY + imageHeight + 8, {
        width: columnWidth,
      });
    });
    doc.y = rowY + rowHeight;
  }
}

export function evidenceWordBlocks(evidence = []) {
  if (evidence.length === 0) return [];
  const blocks = [new Paragraph({ spacing: { before: 320, after: 100 }, keepNext: true, children: [new TextRun({ text: 'Annexe — Photos de preuve', bold: true, size: 26, color: INK })] })];
  evidence.forEach((item, index) => {
    const { width, height } = imageSize(item.buffer);
    const scale = Math.min(460 / width, 300 / height, 1);
    const imageType = item.mime_type === 'image/png' ? 'png' : 'jpeg';
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        keepNext: true,
        keepLines: true,
        spacing: { before: 80, after: 50 },
        children: [new ImageRun({ type: imageType, data: item.buffer, transformation: { width: width * scale, height: height * scale } })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        keepLines: true,
        spacing: { after: 160 },
        children: [new TextRun({ text: `${index + 1}. ${item.caption || item.file_name}`, size: 18, color: MUTED })],
      })
    );
  });
  return blocks;
}
