import { expect, it, vi } from 'vitest';
import { appendEvidenceToPdf } from './evidenceExport.js';

it('places evidence photos in separate bounded grid cells and starts a new page when needed', () => {
  const imageCalls = [];
  const doc = {
    y: 120,
    page: { height: 700, margins: { bottom: 50 } },
    font: vi.fn(() => doc),
    fontSize: vi.fn(() => doc),
    fillColor: vi.fn(() => doc),
    text: vi.fn(() => doc),
    heightOfString: vi.fn(() => 28),
    moveDown: vi.fn(() => {
      doc.y += 15;
      return doc;
    }),
    image: vi.fn((buffer, x, y, options) => imageCalls.push({ x, y, options })),
    addPage: vi.fn(() => {
      doc.y = 100;
    }),
  };
  const evidence = Array.from({ length: 6 }, (_, index) => ({
    buffer: Buffer.from(`photo-${index}`),
    file_name: `photo-${index}.jpg`,
  }));

  appendEvidenceToPdf(doc, evidence, { marginX: 50, contentWidth: 495 });

  expect(imageCalls).toHaveLength(6);
  expect(imageCalls[0].y).toBe(imageCalls[1].y);
  expect(imageCalls[0].x).toBeLessThan(imageCalls[1].x);
  expect(imageCalls[2].y - imageCalls[0].y).toBeGreaterThanOrEqual(244);
  expect(imageCalls[2].y).toBe(imageCalls[3].y);
  expect(doc.addPage).toHaveBeenCalled();
  expect(imageCalls.every(({ options }) => options.fit[1] === 190)).toBe(true);
});
