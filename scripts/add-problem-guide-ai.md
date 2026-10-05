# Guide de resolution : deploiement

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

`POST /api/ai/problem-guide-search` exige une session et un texte de 3 a 1200
caracteres. Le serveur verifie la recherche locale et les acces avant de reserver
une action. Il ne propose que des modules accessibles, rejette les identifiants
inventes et recontrole les permissions apres generation.

La bibliotheque locale est copiee depuis le depot frontend pour permettre les
deploiements independants. Depuis le workspace contenant les deux depots :

```sh
node frontend/scripts/sync-problem-guide.mjs
node frontend/scripts/sync-problem-guide.mjs --check
```

Inclure les copies generees dans le commit backend. Les tests des deux depots
restent executables separement.
