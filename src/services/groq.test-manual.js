// Script manuel (pas Jest) pour vérifier que l'intégration Groq fonctionne avant de la
// brancher à une route API. Lancer depuis backend/ avec : node src/services/groq.test-manual.js
import 'dotenv/config';
import { generateQqoqccpSuggestion } from './groq.js';

const sampleAnalysis = {
  qui: "L'équipe achats et le fournisseur de composants électroniques",
  quoi: "Rupture de stock sur le composant X empêchant la production de la ligne A",
  ou_: 'Entrepôt principal, ligne de production A',
  quand_: 'Détecté le 15/08/2026, impact depuis 3 jours',
  comment_: 'Alerte automatique du système de gestion de stock (seuil minimal atteint sans réapprovisionnement)',
  combien: "3 jours d'arrêt de production, environ 12 000€ de perte estimée",
  pourquoi: 'Le seuil de réapprovisionnement automatique semble mal paramétré, et le fournisseur a signalé un retard non communiqué à temps',
};

async function main() {
  console.log('Appel de generateQqoqccpSuggestion avec des données d\'exemple...\n');
  try {
    const result = await generateQqoqccpSuggestion(sampleAnalysis);
    console.log('Résultat :');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Échec :', err.message);
    process.exitCode = 1;
  }
}

main();
