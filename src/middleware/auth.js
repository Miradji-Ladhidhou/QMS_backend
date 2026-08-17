import { supabase } from '../services/supabase.js';

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }

  const token = authHeader.slice('Bearer '.length);

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

  next();
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
