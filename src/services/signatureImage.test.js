import { describe, it, expect } from 'vitest';
import { validateSignatureImage } from './signatureImage.js';

// PNG 1×1 valide.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const png = (b64 = PNG_1X1) => `data:image/png;base64,${b64}`;

// PNG factice de dimensions données (signature PNG + IHDR), pour tester les bornes sans vraie image.
function fakePng(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString('base64');
}

describe('validateSignatureImage', () => {
  it('accepte un vrai PNG', () => {
    const result = validateSignatureImage(png());
    expect(result.error).toBeUndefined();
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('refuse ce qui n\'est pas une data URL PNG : vide, nombre, objet, autre type, texte', () => {
    for (const value of [undefined, null, 42, {}, [], '', 'texte', 'data:image/jpeg;base64,AAAA', 'data:text/html;base64,PHNjcmlwdD4=', 'http://exemple.fr/sig.png']) {
      expect(validateSignatureImage(value).error).toBeTruthy();
    }
  });

  it('refuse un contenu qui n\'est pas réellement un PNG malgré le bon préfixe', () => {
    expect(validateSignatureImage(png(Buffer.from('<script>alert(1)</script>').toString('base64'))).error).toMatch(/PNG/);
    expect(validateSignatureImage(png('!!!pas du base64!!!')).error).toMatch(/illisible/);
    expect(validateSignatureImage(png('')).error).toBeTruthy();
  });

  it('refuse une image trop volumineuse ou trop grande', () => {
    const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400 * 1024)]).toString('base64');
    expect(validateSignatureImage(png(huge)).error).toMatch(/volumineuse/);
    expect(validateSignatureImage(png(fakePng(5000, 100))).error).toBeTruthy();
    expect(validateSignatureImage(png(fakePng(400, 3000))).error).toBeTruthy();
    expect(validateSignatureImage(png(fakePng(600, 200))).error).toBeUndefined();
  });
});
