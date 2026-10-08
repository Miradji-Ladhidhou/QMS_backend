import { AlignmentType, ImageRun, Paragraph, TextRun } from 'docx';
import imageSize from 'image-size';

const INK = '1E293B';
const MUTED = '64748B';

export function appendEvidenceToPdf(doc, evidence = [], { marginX, contentWidth }) {
  if (evidence.length === 0) return;
  if (doc.y > doc.page.height - 100) doc.addPage();
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text('Annexe — Photos de preuve', marginX, doc.y, { width: contentWidth });
  doc.font('Body');
  doc.moveDown(0.5);

  const columnGap = 16;
  const columnWidth = (contentWidth - columnGap) / 2;
  const imageHeight = 190;
  const rowHeight = 244;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  for (let index = 0; index < evidence.length; index += 2) {
    if (doc.y + rowHeight > pageBottom()) doc.addPage();
    const rowY = doc.y;
    evidence.slice(index, index + 2).forEach((item, column) => {
      const x = marginX + column * (columnWidth + columnGap);
      const caption = Array.from(item.caption || item.file_name).slice(0, 100).join('');
      const captionText = `${index + column + 1}. ${caption}${caption.length >= 100 ? '…' : ''}`;
      doc.image(item.buffer, x, rowY, {
        fit: [columnWidth, imageHeight],
        align: 'center',
        valign: 'center',
      });
      doc.fontSize(9).fillColor(INK).text(captionText, x, rowY + imageHeight + 8, {
        width: columnWidth,
        height: 34,
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
        spacing: { before: 80, after: 50 },
        children: [new ImageRun({ type: imageType, data: item.buffer, transformation: { width: width * scale, height: height * scale } })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new TextRun({ text: `${index + 1}. ${item.caption || item.file_name}`, size: 18, color: MUTED })],
      })
    );
  });
  return blocks;
}
