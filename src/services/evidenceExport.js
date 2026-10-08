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

  evidence.forEach((item, index) => {
    const dimensions = imageSize(item.buffer);
    const scale = Math.min(contentWidth / dimensions.width, 300 / dimensions.height, 1);
    const width = dimensions.width * scale;
    const height = dimensions.height * scale;
    const caption = item.caption || item.file_name;
    const captionHeight = doc.fontSize(9).heightOfString(caption, { width: contentWidth });
    if (doc.y + height + captionHeight + 24 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.image(item.buffer, marginX + (contentWidth - width) / 2, doc.y, { width, height });
    doc.y += height + 6;
    doc.fontSize(9).fillColor(INK).text(`${index + 1}. ${caption}`, marginX, doc.y, { width: contentWidth });
    doc.moveDown(0.45);
  });
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
