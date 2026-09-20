import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { buildListReportWord } from './listReportWord.js';

// PNG 1×1 valide (même fixture que procedureWord.test.js).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const BASE = {
  tenantName: 'Entreprise Test',
  title: 'Registre des risques',
  generatedBy: 'Marie Dupont',
  columns: [{ key: 'title', label: 'Titre' }],
  rows: [{ title: 'Risque 1' }],
};

async function zipOf(buffer) {
  return JSZip.loadAsync(buffer);
}

describe('buildListReportWord — logo du tenant', () => {
  it('embarque le logo dans l\'en-tête de section (répété sur chaque page)', async () => {
    const buffer = await buildListReportWord({ ...BASE, tenantLogo: TINY_PNG });
    const zip = await zipOf(buffer);

    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);

    // L'image est référencée depuis un fichier header*.xml, pas depuis le corps du document :
    // un en-tête est ce qui se répète sur toutes les pages en Word.
    const headerFiles = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name));
    expect(headerFiles.length).toBeGreaterThan(0);
    const headerXml = await zip.file(headerFiles[0]).async('string');
    expect(headerXml).toContain('<w:drawing>');

    // Le document reste lisible et contient toujours les données.
    const { value } = await mammoth.extractRawText({ buffer });
    expect(value).toContain('Risque 1');
  });

  it('sans logo : aucune image embarquée, titre seul dans l\'en-tête', async () => {
    const buffer = await buildListReportWord(BASE);
    const zip = await zipOf(buffer);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(false);
  });

  it('logo illisible : pas d\'erreur, document généré sans image', async () => {
    const buffer = await buildListReportWord({ ...BASE, tenantLogo: Buffer.from('pas une image') });
    const zip = await zipOf(buffer);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(false);
  });
});
