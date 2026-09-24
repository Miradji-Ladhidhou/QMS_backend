import { describe, it, expect } from 'vitest';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { buildProcedureWordDocument } from './procedureWord.js';

// Même outil que services/textExtraction.js pour lire un .docx déjà existant : réutilisé ici
// en sens inverse, pour vérifier qu'un buffer produit par buildProcedureWordDocument s'ouvre
// sans erreur (un .docx corrompu ferait échouer extractRawText) ET contient bien le texte
// attendu — plus fiable qu'une simple assertion "le buffer n'est pas vide".
async function textOf(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

// Compte les occurrences de <w:cantSplit/> dans word/document.xml — mammoth n'expose pas cette
// propriété OOXML (voir le plan de refonte), seule une inspection directe du zip le peut.
async function countCantSplit(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return (xml.match(/<w:cantSplit\/>/g) || []).length;
}

async function hasEmbeddedMedia(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).some((name) => name.startsWith('word/media/'));
}

async function documentXml(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml').async('string');
}

// Somme des largeurs de <w:gridCol> pour chaque <w:tbl> du document — un Math.round colonne par
// colonne peut décaler cette somme de quelques twips par rapport à la largeur déclarée du
// tableau (bug réel constaté : LibreOffice tolère l'écart, Word désaligne les bordures entre
// l'en-tête et les lignes de données). Toutes les tables de ce renderer partagent la même
// largeur totale (TABLE_WIDTH_DXA = 9026, voir procedureWord.js), donc chaque somme doit y être
// strictement égale.
async function tableColumnWidthSums(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return xml
    .split('<w:tbl>')
    .slice(1)
    .map((block) => [...block.matchAll(/<w:gridCol w:w="(\d+)"/g)].reduce((sum, m) => sum + parseInt(m[1], 10), 0));
}

const PROCEDURE = { number: 'PROC-042', title: 'Préparation de commande', process: 'Logistique', status: 'draft', next_review_date: '2027-01-01' };

const AUTHOR = { full_name: 'Alice Rédactrice' };
const VALIDATOR = { full_name: 'Bob Validateur' };

// Un 1x1 PNG minimal (même fixture que le smoke test manuel effectué pendant l'implémentation).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// Contenu "façon IA" : exactement la forme produite par subsectionToBlocks dans
// procedureFullDraftJob.js — sous_titre, paragraphe (intro), paragraphe (actions numérotées),
// encadre (callout, sans severity), photo_placeholder.
function aiStyleSection() {
  return {
    key: 'processus',
    label: 'Processus',
    blocks: [
      { type: 'sous_titre', id: 'b1', text: 'Réception de la commande' },
      { type: 'paragraphe', id: 'b2', text: "Introduction de l'étape de réception." },
      { type: 'paragraphe', id: 'b3', text: '1. Vérifier le bon de commande.\n   - Vérifier la référence client' },
      { type: 'encadre', id: 'b4', text: 'Ne jamais expédier un colis non contrôlé.' },
      { type: 'photo_placeholder', id: 'b5', caption: 'Photo du bon de commande réceptionné' },
      { type: 'sous_titre', id: 'b6', text: 'Étape en échec' },
      { type: 'paragraphe', id: 'b7', text: 'À compléter manuellement — la génération automatique de cette sous-section a échoué.' },
    ],
  };
}

// Contenu "façon manuel" : ce qu'un rédacteur produit dans ProcedureSectionsEditor.jsx —
// paragraphe simple, liste à puces, tableau libre.
function manualStyleSection() {
  return {
    key: 'controles',
    label: 'Contrôles et indicateurs',
    blocks: [
      { type: 'paragraphe', id: 'm1', text: 'Contenu rédigé à la main, sans IA.' },
      { type: 'liste_puces', id: 'm2', items: ['Vérifier le poids', 'Vérifier le scellé'] },
      { type: 'tableau', id: 'm3', headers: ['Indicateur', 'Cible', 'Fréquence', 'Responsable'], rows: [['Taux de non-conformité', '< 2%', 'Mensuelle', 'QHSE']] },
    ],
  };
}

function richVersion(overrides = {}) {
  return {
    version: '1.0',
    status: 'draft',
    created_at: '2026-01-01T00:00:00Z',
    author: AUTHOR,
    validator: null,
    content: {
      sections: [aiStyleSection(), manualStyleSection()],
      documents_associes: ['Bon de commande', 'Fiche de contrôle'],
    },
    ...overrides,
  };
}

const VERSIONS = [richVersion(), { version: '0.9', status: 'rejected', created_at: '2025-12-01T00:00:00Z', author: AUTHOR, validator: VALIDATOR, validated_at: '2025-12-02T00:00:00Z' }];

describe('buildProcedureWordDocument', () => {
  it('produit un .docx valide contenant tous les types de blocs, façon IA et façon manuel confondues (même renderer)', async () => {
    const buffer = await buildProcedureWordDocument({
      accentColor: '#7A2E3B',
      visualOptions: { band: true, bulletStyle: 'round', calloutStyle: 'full-tint' },
      tenantLogo: TINY_PNG,
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    const text = await textOf(buffer);
    expect(text).toContain(PROCEDURE.number);
    expect(text).toContain(PROCEDURE.title);
    // façon IA
    expect(text).toContain('Réception de la commande');
    expect(text).toContain('Vérifier le bon de commande');
    expect(text).toContain("Point d'attention");
    expect(text).toContain('Ne jamais expédier un colis non contrôlé.');
    expect(text).toContain('Emplacement réservé à une photo');
    expect(text).toContain('À compléter manuellement');
    // façon manuel
    expect(text).toContain('Contenu rédigé à la main, sans IA.');
    expect(text).toContain('Vérifier le poids');
    expect(text).toContain('Indicateur');
    expect(text).toContain('Taux de non-conformité');
    // documents associés + historique
    expect(text).toContain('Bon de commande');
    expect(text).toContain('Historique des versions');
    expect(text).toContain('v0.9');

    expect(await hasEmbeddedMedia(buffer)).toBe(true);
  });

  it('utilise les défauts neutres quand aucun accentColor/visualOptions n’est fourni (tenant jamais configuré)', async () => {
    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const text = await textOf(buffer);
    expect(text).toContain(PROCEDURE.title);
  });

  it('sommaire reflète une structure modifiée après coup (section renommée + section ajoutée)', async () => {
    const version = richVersion();
    version.content.sections[0].label = 'Processus (révisé)';
    version.content.sections.push({ key: 'annexes', label: 'Annexes', blocks: [{ type: 'paragraphe', id: 'x1', text: 'Voir fiches jointes.' }] });

    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version,
      versions: [version],
    });
    const text = await textOf(buffer);
    expect(text).toContain('Sommaire');
    expect(text).toContain('Processus (révisé)');
    expect(text).toContain('Annexes');
  });

  it('génère un sommaire Word actualisable avec des titres paginables', async () => {
    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('TOC \\o &quot;1-2&quot;');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
  });

  it('un sommaire réécrit à la main (section key "sommaire") est rendu tel quel, jamais écrasé par le calcul automatique', async () => {
    const version = richVersion();
    // Texte délibérément DIFFÉRENT des libellés de section réels — la preuve que ce n'est pas le
    // calcul automatique qui s'applique : si l'auto-génération l'emportait, ce texte n'apparaîtrait
    // jamais et les vrais libellés de section ("Processus", "Contrôles et indicateurs") seraient
    // listés à la place.
    version.content.sections.unshift({
      key: 'sommaire',
      label: 'Sommaire',
      blocks: [{ type: 'liste_puces', id: 's1', items: ['Introduction (réécrite à la main)', 'Voir annexe C pour le détail'] }],
    });

    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version,
      versions: [version],
    });
    const text = await textOf(buffer);
    expect(text).toContain('Introduction (réécrite à la main)');
    expect(text).toContain('Voir annexe C pour le détail');
    // Le calcul automatique n'a pas tourné en plus : un seul "Sommaire" dans le document (celui
    // du contenu manuel), pas un deuxième généré automatiquement à la suite.
    expect(text.match(/Sommaire/g)).toHaveLength(1);
  });

  it('table à colonnes libres : cantSplit sur chaque ligne (identité + historique + tableau manuel)', async () => {
    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    // 8 lignes d'identité + 3 lignes d'historique (en-tête + 2 versions, voir VERSIONS) + 2
    // lignes du tableau manuel (en-tête + 1 ligne) = 13.
    expect(await countCantSplit(buffer)).toBe(13);
  });

  it('la somme des largeurs de colonnes de chaque tableau tombe exactement sur la largeur déclarée (jamais un twip d’écart)', async () => {
    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    const sums = await tableColumnWidthSums(buffer);
    // Identité (2 col.) + tableau manuel (4 col.) + historique (5 col.) = 3 tableaux, tous à la
    // même largeur totale.
    expect(sums).toHaveLength(3);
    sums.forEach((sum) => expect(sum).toBe(9026));
  });

  it('sans logo tenant : aucun emplacement vide, aucune image embarquée', async () => {
    const buffer = await buildProcedureWordDocument({
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    expect(await hasEmbeddedMedia(buffer)).toBe(false);
  });
});
