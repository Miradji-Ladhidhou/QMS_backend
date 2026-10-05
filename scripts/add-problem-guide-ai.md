# Guide de resolution : deploiement

## Assistance temporairement desactivee

Le guide utilise maintenant deux selecteurs locaux (secteur et type de probleme).
`POST /api/ai/problem-guide-search` renvoie HTTP 403 avec `AI_MODULE_DISABLED`
pour toute session, independamment des reglages entreprise et forfait.
Aucun appel fournisseur ni reservation de quota n'est effectue.
Les autres fonctions IA de l'application restent inchangees.
La migration ci-dessous reste utile pour les installations ayant deploye
la version precedente ; aucune nouvelle migration n'est necessaire pour les selecteurs.

## Infrastructure historique du secours

Avant de deployer le backend et le frontend, executer
[add-problem-guide-ai.sql](./add-problem-guide-ai.sql) sur la base cible,
apres `add-ai-commercial-settings.sql`.
Le script est idempotent ; il etend les cles de configuration et de reservation
de quotas IA sans modifier les donnees metier. Il a ete applique localement,
pas en production.

La cle IA `problem_guide` permet de desactiver le secours dans les reglages
entreprise ou les modeles de forfait. Une cle absente est active, comme pour les
autres fonctions IA. Les quotas entreprise/utilisateur et les limites Groq
existants restent appliques.

La bibliotheque locale est copiee depuis le depot frontend pour permettre les
deploiements independants. Depuis le workspace contenant les deux depots :

```sh
node frontend/scripts/sync-problem-guide.mjs
node frontend/scripts/sync-problem-guide.mjs --check
```

Inclure les copies generees dans le commit backend. Les tests des deux depots
restent executables separement.
