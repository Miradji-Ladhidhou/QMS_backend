import { describe, it, expect } from 'vitest';
import mammoth from 'mammoth';
import { buildProcedureWordDocument, findStyleTheme } from './procedureWord.js';

// Même outil que services/textExtraction.js pour lire un .docx déjà existant : réutilisé ici
// en sens inverse, pour vérifier qu'un buffer produit par buildProcedureWordDocument s'ouvre
// sans erreur (un .docx corrompu ferait échouer extractRawText) ET contient bien le texte
// attendu — plus fiable qu'une simple assertion "le buffer n'est pas vide".
async function textOf(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

const PROCEDURE = { number: 'PROC-042', title: 'Préparation de commande', process: 'Logistique', status: 'draft', next_review_date: '2027-01-01' };

const AUTHOR = { full_name: 'Alice Rédactrice' };
const VALIDATOR = { full_name: 'Bob Validateur' };

function richVersion(overrides = {}) {
  return {
    version: '1.0',
    status: 'draft',
    created_at: '2026-01-01T00:00:00Z',
    author: AUTHOR,
    validator: null,
    content: {
      objet: 'Objet de test',
      domaine_application: 'Domaine de test',
      responsabilites: 'Responsabilités de test',
      sections: [
        {
          key: 'processus',
          label: 'Processus',
          content: 'texte à plat ignoré quand subsections est présent',
          subsections: [
            {
              title: 'Réception de la commande',
              intro: "Introduction de l'étape de réception.",
              actions: [{ text: 'Vérifier le bon de commande.', sub_bullets: ['Vérifier la référence client'] }],
              callout: { severity: 'danger', text: 'Ne jamais expédier un colis non contrôlé.' },
              photo_placeholders: ['Photo du bon de commande réceptionné'],
              generation_status: 'ok',
            },
            {
              title: 'Sous-section en échec',
              intro: null,
              actions: [],
              callout: null,
              photo_placeholders: [],
              generation_status: 'failed',
            },
          ],
        },
      ],
      documents_associes: ['Bon de commande', 'Fiche de contrôle'],
    },
    ...overrides,
  };
}

const VERSIONS = [richVersion(), { version: '0.9', status: 'rejected', created_at: '2025-12-01T00:00:00Z', author: AUTHOR, validator: VALIDATOR, validated_at: '2025-12-02T00:00:00Z' }];

describe('findStyleTheme', () => {
  it('retombe sur le style neutre pour un preset_id inconnu ou absent', () => {
    expect(findStyleTheme('inexistant')).toBe(findStyleTheme(null));
    expect(findStyleTheme(undefined).fontFamily).toBe('Times New Roman');
  });
});

describe.each([
  { presetId: 'mtl-logistique', calloutLabel: 'Important', photoMarker: 'Emplacement réservé à une photo' },
  { presetId: 'iso-generique', calloutLabel: 'Attention', photoMarker: 'Emplacement réservé à une photo' },
  { presetId: 'moderne-tertiaire', calloutLabel: 'À retenir', photoMarker: 'Emplacement réservé à une photo' },
  { presetId: 'industriel-securite', calloutLabel: 'DANGER', photoMarker: 'Emplacement réservé à une photo' },
])('buildProcedureWordDocument — style $presetId', ({ presetId, calloutLabel, photoMarker }) => {
  it('produit un .docx valide contenant les sections, le callout et le placeholder photo attendus', async () => {
    const buffer = await buildProcedureWordDocument({
      presetId,
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
    expect(text).toContain('Objet de test');
    expect(text).toContain('Réception de la commande');
    expect(text).toContain('Vérifier le bon de commande');
    expect(text).toContain('génération automatique de cette sous-section a échoué');
    expect(text).toContain(calloutLabel);
    expect(text).toContain(photoMarker);
    expect(text).toContain('Bon de commande'); // documents_associes
    expect(text).toContain('Historique des versions');
    expect(text).toContain('v0.9'); // ligne de l'historique
  });
});

describe('buildProcedureWordDocument — repli sur le format court (sans subsections)', () => {
  it('rend section.content à plat quand aucune sous-section structurée n’est présente', async () => {
    const version = {
      version: '1.0',
      status: 'draft',
      created_at: '2026-01-01T00:00:00Z',
      author: AUTHOR,
      validator: null,
      content: {
        objet: 'Objet court',
        domaine_application: 'Domaine court',
        responsabilites: 'Responsabilités courtes',
        sections: [{ key: 'etapes', label: 'Étapes du processus', content: 'Contenu rédigé à la main, sans IA.' }],
        documents_associes: [],
      },
    };

    const buffer = await buildProcedureWordDocument({
      presetId: 'iso-generique',
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version,
      versions: [version],
    });

    const text = await textOf(buffer);
    expect(text).toContain('Étapes du processus');
    expect(text).toContain('Contenu rédigé à la main, sans IA.');
  });
});

describe('buildProcedureWordDocument — encadré DANGER en tête de document (industriel-securite uniquement)', () => {
  it('ajoute un encadré DANGER en haut du document quand une sous-section a un callout danger', async () => {
    const buffer = await buildProcedureWordDocument({
      presetId: 'industriel-securite',
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version: richVersion(),
      versions: VERSIONS,
    });
    const text = await textOf(buffer);
    expect(text).toContain('risque grave');
  });

  it('ne l’ajoute pas quand aucune sous-section n’a de callout danger', async () => {
    const version = richVersion();
    version.content.sections[0].subsections[0].callout = null;
    const buffer = await buildProcedureWordDocument({
      presetId: 'industriel-securite',
      tenantName: 'Entreprise Test',
      procedure: PROCEDURE,
      version,
      versions: [version],
    });
    const text = await textOf(buffer);
    expect(text).not.toContain('risque grave');
  });
});
