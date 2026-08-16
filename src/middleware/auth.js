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
    .select('tenant_id, role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'Profil utilisateur introuvable.' });
  }

  req.user = user;
  req.tenantId = profile.tenant_id;
  req.userRole = profile.role;

  next();
}
