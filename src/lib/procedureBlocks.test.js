import { describe, it, expect } from 'vitest';
import { textToParagraphBlocks, draftToBlockContent, blocksToPlainText } from './procedureBlocks.js';

describe('textToParagraphBlocks', () => {
  it('un bloc paragraphe par ligne non vide, avec un id unique', () => {
    const blocks = textToParagraphBlocks('Première ligne.\n\nDeuxième ligne.\n   \nTroisième ligne.');
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.type)).toEqual(['paragraphe', 'paragraphe', 'paragraphe']);
    expect(blocks.map((b) => b.text)).toEqual(['Première ligne.', 'Deuxième ligne.', 'Troisième ligne.']);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3); // ids tous distincts
  });

  it('texte vide/absent -> tableau vide, jamais un bloc avec un texte vide', () => {
    expect(textToParagraphBlocks('')).toEqual([]);
    expect(textToParagraphBlocks(undefined)).toEqual([]);
    expect(textToParagraphBlocks('   \n  \n')).toEqual([]);
  });
});

describe('draftToBlockContent', () => {
  it('convertit sections[].content (texte à plat) en sections[].blocks', () => {
    const draft = {
      sections: [
        { key: 'objet', label: 'Objet', content: 'Ligne 1.\nLigne 2.' },
        { key: 'vide', label: 'Section vide', content: '' },
      ],
      documents_associes: ['Doc A'],
    };
    const result = draftToBlockContent(draft);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].key).toBe('objet');
    expect(result.sections[0].blocks).toEqual([
      expect.objectContaining({ type: 'paragraphe', text: 'Ligne 1.' }),
      expect.objectContaining({ type: 'paragraphe', text: 'Ligne 2.' }),
    ]);
    expect(result.sections[1].blocks).toEqual([]);
    expect(result.documents_associes).toEqual(['Doc A']);
  });

  it('draft vide/absent -> content vide, jamais une exception', () => {
    expect(draftToBlockContent(null)).toEqual({ sections: [], documents_associes: [] });
    expect(draftToBlockContent(undefined)).toEqual({ sections: [], documents_associes: [] });
    expect(draftToBlockContent({})).toEqual({ sections: [], documents_associes: [] });
  });
});

describe('blocksToPlainText', () => {
  it('rend chaque type de bloc en texte lisible pour un prompt IA', () => {
    const blocks = [
      { type: 'sous_titre', text: 'Réception' },
      { type: 'paragraphe', text: 'Un paragraphe.' },
      { type: 'liste_puces', items: ['Item A', 'Item B'] },
      { type: 'tableau', headers: ['Col1', 'Col2'], rows: [['a', 'b']] },
      { type: 'encadre', text: 'Attention au sol glissant.' },
      { type: 'photo_placeholder', caption: 'Photo du poste' },
    ];
    const text = blocksToPlainText(blocks);
    expect(text).toContain('Réception');
    expect(text).toContain('Un paragraphe.');
    expect(text).toContain('- Item A');
    expect(text).toContain('- Item B');
    expect(text).toContain('Col1 | Col2');
    expect(text).toContain('a | b');
    expect(text).toContain("Point d'attention : Attention au sol glissant.");
    expect(text).toContain('[ Emplacement réservé à une photo : Photo du poste ]');
  });

  it('blocs vides/absents -> chaîne vide', () => {
    expect(blocksToPlainText([])).toBe('');
    expect(blocksToPlainText(undefined)).toBe('');
  });
});
