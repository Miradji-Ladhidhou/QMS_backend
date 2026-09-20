import rateLimit from 'express-rate-limit';

// La suite de tests (vitest, NODE_ENV=test) provisionne ses tenants directement via le client
// Supabase service-role (voir test-utils/tenant.js), jamais via une route HTTP de ce routeur —
// mais un test peut encore appeler POST /auth/activity, désactivé ici pour rester au-dessus de
// tout seuil réaliste, actif en développement/production.
const skipInTests = () => process.env.NODE_ENV === 'test';

// POST /api/auth/activity (le seul point d'entrée restant sur ce routeur depuis que
// l'inscription publique /register a été retirée — la création de compte passe désormais
// exclusivement par POST /super-admin/tenants, réservée au super admin) est la seule route
// non authentifiée qui écrit en base (journal d'activité) — sans limite, un script pourrait la
// spammer. Le reste de l'authentification (login, mot de passe oublié) passe directement par
// le SDK Supabase côté client, hors du périmètre de ce backend.
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Trop de tentatives de création de compte. Réessayez plus tard.' },
});

// Filet de sécurité général sur le reste de l'API (toutes les routes sont authentifiées à ce
// stade, mais un compte compromis ou un bug client pourrait sinon marteler l'API sans limite).
// Largement au-dessus de tout usage normal de l'application pour ne jamais gêner un usage
// légitime — voir même principe que RECORD_ROWS_MAX/le plafond sur POST /reports/table-pdf :
// une limite haute qui n'existe que pour couper un abus, pas pour contraindre l'usage normal.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Trop de requêtes, réessayez dans quelques minutes.' },
});

// Pages publiques du QCM de formation (routes/publicQuiz.js), ouvertes sans compte depuis un lien
// email. Plafond par IP volontairement large : toute une équipe passe souvent le QCM depuis le
// même réseau d'entreprise (donc la même IP). Ce n'est pas la protection principale — jeton de
// 256 bits + verrouillage du lien après quelques emails erronés — seulement un filet contre un
// script qui martèlerait ces routes.
export const publicQuizLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Trop de requêtes, réessayez dans quelques minutes.' },
});
