import jwt from 'jsonwebtoken';
import { supabase } from '../services/supabase.js';
import { runWithRequestContext } from '../services/requestContext.js';

// Vérification LOCALE de la signature (HS256, secret JWT du projet — voir SUPABASE_JWT_SECRET
// dans .env.example) plutôt qu'un appel réseau à supabase.auth.getUser(token) : ce dernier
// ajoutait un aller-retour réseau complet à CHAQUE requête authentifiée de l'application (donc
// littéralement à chaque clic, en plus de la requête sur la table users juste en dessous) — une
// des principales causes de saccade mesurée en production (latence de base ~300-900ms par
// requête vers l'hébergeur). Un jeton Supabase est un JWT auto-suffisant, sa signature se
// vérifie sans round-trip réseau. Le contrôle "ce compte existe encore et est actif" reste
// entièrement assuré par la requête sur users juste après : un utilisateur supprimé/désactivé
// échoue toujours cette étape, donc aucune perte de sécurité par rapport à l'appel réseau
// qu'il remplace.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }

  const token = authHeader.slice('Bearer '.length);

  let payload;
  try {
    payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  // id/email en tête : ce sont les 2 seuls champs de req.user lus ailleurs dans l'appli (voir
  // req.user.id/req.user.email un peu partout) — sub est le nom du champ id dans un JWT
  // standard, jamais utilisé tel quel côté appelant.
  const user = { id: payload.sub, email: payload.email, ...payload };

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
