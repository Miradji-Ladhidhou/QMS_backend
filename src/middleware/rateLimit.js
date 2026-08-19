import rateLimit from 'express-rate-limit';

// La suite de tests (vitest, NODE_ENV=test — voir test-utils/tenant.js) crée un tenant par
// test via POST /auth/register, largement au-dessus de tout seuil réaliste pour un vrai
// utilisateur — désactivé uniquement dans cet environnement, actif en développement/production.
const skipInTests = () => process.env.NODE_ENV === 'test';

// POST /api/auth/register est la seule route non authentifiée qui écrit en base (création
// tenant + compte Supabase Auth) — sans limite, un script peut la spammer pour créer des
// tenants/comptes en masse. Le reste de l'authentification (login, mot de passe oublié) passe
// directement par le SDK Supabase côté client, hors du périmètre de ce backend.
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
