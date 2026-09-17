import jwt from 'jsonwebtoken';
import { supabase } from '../services/supabase.js';
import { runWithRequestContext } from '../services/requestContext.js';

// Diagnostic temporaire, best-effort, jamais bloquant (voir la tentative de vérification
// locale du jeton, annulée : ça vérifiait correctement un jeton auto-signé avec
// SUPABASE_JWT_SECRET, mais rejetait les vrais jetons Supabase — signe que ce projet utilise
// peut-être des clés de signature asymétriques plutôt que le secret partagé HS256 "legacy").
// N'affecte RIEN du comportement de connexion : getUser() reste la seule vérification réelle
// juste en dessous, ceci ne fait que journaliser l'algorithme du jeton une fois par requête.
let jwtAlgLogged = false;
function logJwtAlgOnce(token) {
  if (jwtAlgLogged) return;
  try {
    const decoded = jwt.decode(token, { complete: true });
    console.log('[diag] en-tête du jeton reçu :', JSON.stringify(decoded?.header));
    jwtAlgLogged = true;
  } catch {
    // best-effort, jamais bloquant
  }
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }

  const token = authHeader.slice('Bearer '.length);
  logJwtAlgOnce(token);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('tenant_id, role, is_super_admin, is_active, tenant:tenants(is_suspended)')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'Profil utilisateur introuvable.' });
  }

  // Un tenant suspendu (espace super admin) bloque ses utilisateurs sans supprimer aucune
  // donnée — sauf le super admin lui-même, qui doit pouvoir intervenir en toutes circonstances.
  if (profile.tenant?.is_suspended && !profile.is_super_admin) {
    return res.status(403).json({ error: 'Ce compte est suspendu. Contactez votre administrateur.' });
  }

  if (!profile.is_active) {
    return res.status(403).json({ error: 'Ce compte a été désactivé.' });
  }

  req.user = user;
  req.tenantId = profile.tenant_id;
  req.userRole = profile.role;
  req.isSuperAdmin = profile.is_super_admin;

  // Établit le contexte de requête (voir services/requestContext.js) pour toute la suite du
  // traitement de CETTE requête — englobe next() pour couvrir aussi bien les middlewares/routes
  // synchrones que leurs opérations asynchrones (Node propage l'AsyncLocalStorage à travers
  // await/Promise/setTimeout automatiquement).
  runWithRequestContext({ tenantId: profile.tenant_id, userId: user.id }, next);
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }
    next();
  };
}

export function requireSuperAdmin(req, res, next) {
  if (!req.isSuperAdmin) {
    return res.status(403).json({ error: 'Réservé au super administrateur.' });
  }
  next();
}
