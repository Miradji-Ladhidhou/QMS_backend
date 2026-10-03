import { describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { extractProcedureSectionsFromDocx, procedureSectionsFromHtml } from './procedureContentExtraction.js';

describe('procedureSectionsFromHtml', () => {
  it('ignore la couverture et le sommaire source, puis conserve les rubriques, sous-rubriques, listes et tableaux', () => {
    const sections = procedureSectionsFromHtml(`
      <p>Nom de l'entreprise</p>
      <p><strong>Sommaire</strong></p>
      <table><tr><td>1. Objectifs</td><td>page 3</td></tr></table>
      <p><strong>1. Objectifs de la procédure</strong></p>
      <p>Décrire le processus.</p>
      <ul><li>Contrôle qualité</li></ul>
      <p><strong>3. Responsabilités</strong></p>
      <table>
        <tr><td><p><strong>Poste</strong></p></td><td><p><strong>Responsabilités</strong></p></td></tr>
        <tr><td><p>Responsable</p></td><td><p>Pilote la procédure.</p></td></tr>
      </table>
      <p><strong>4. Processus</strong></p>
      <p><strong>4.1 Réception</strong></p>
      <ol><li>Confirmer la demande<ul><li>Vérifier le périmètre</li></ul></li></ol>
    `);

    expect(sections.map((section) => section.label)).toEqual([
      'Objectifs de la procédure',
      'Responsabilités',
      'Processus',
    ]);
    expect(sections[0].blocks.map((block) => block.type)).toEqual(['paragraphe', 'liste_puces']);
    expect(sections[1].blocks[0]).toMatchObject({
      type: 'tableau',
      hasHeader: true,
      headers: ['Poste', 'Responsabilités'],
      rows: [['Responsable', 'Pilote la procédure.']],
    });
    expect(sections[2].blocks[0]).toMatchObject({ type: 'sous_titre', text: '4.1 Réception' });
    expect(sections[2].blocks.slice(1).map((block) => block.text)).toEqual([
      '1. Confirmer la demande',
      '  • Vérifier le périmètre',
    ]);
  });

  it('garde en une section les documents sans titres structurés et ajoute leur description', () => {
    const sections = procedureSectionsFromHtml('<p>Première étape.</p><p>Deuxième étape.</p>', {
      description: 'Résumé du document.',
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('Contenu repris du document source');
    expect(sections[0].blocks.map((block) => block.text)).toEqual([
      'Résumé du document.',
      'Première étape.',
      'Deuxième étape.',
    ]);
  });

  it('reprend les en-têtes de tableau grisés même lorsqu’ils ne sont pas en gras', async () => {
    const cell = (text, shaded = false) =>
      new TableCell({
        ...(shaded ? { shading: { fill: 'D9D9D9' } } : {}),
        children: [new Paragraph(text)],
      });
    const buffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ text: '1. Contrôles', heading: HeadingLevel.HEADING_1 }),
              new Table({
                rows: [
                  new TableRow({ children: [cell('Contrôle', true), cell('Fréquence', true)] }),
                  new TableRow({ children: [cell('Palette bloquée'), cell('Quotidienne')] }),
                ],
              }),
              new Table({
                rows: [
                  new TableRow({ children: [cell('Date', true), cell('')] }),
                  new TableRow({ children: [cell('Référence'), cell('')] }),
                ],
              }),
              new Table({
                rows: [
                  new TableRow({ children: [cell('Version'), cell('Date'), cell('Modifications')] }),
                  new TableRow({ children: [cell('1.0'), cell('01/01/2026'), cell('Création')] }),
                ],
              }),
            ],
          },
        ],
      })
    );

    const sections = await extractProcedureSectionsFromDocx(buffer);
    expect(sections[0].blocks).toMatchObject([
      { type: 'tableau', hasHeader: true, headers: ['Contrôle', 'Fréquence'], rows: [['Palette bloquée', 'Quotidienne']] },
      { type: 'tableau', hasHeader: false, headers: ['Colonne 1', 'Colonne 2'], rows: [['Date', ''], ['Référence', '']] },
      { type: 'tableau', hasHeader: true, headers: ['Version', 'Date', 'Modifications'], rows: [['1.0', '01/01/2026', 'Création']] },
    ]);
  });
});
