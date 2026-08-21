import { Router } from 'express';
import { google } from 'googleapis';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';
import { encrypt } from '../services/encryption.js';
import {
  getAuthUrl,
  exchangeCodeForTokens,
  createRootFolder,
  verifyState,
  refreshAccessTokenIfNeeded,
} from '../services/googleDrive.js';

const router = Router();

function driveErrorRedirect(res, message) {
  return res.redirect(`${process.env.FRONTEND_URL}/settings?drive=error&message=${encodeURIComponent(message)}`);
}

// GET /api/drive/callback — seul endpoint de ce fichier qui NE PASSE PAS par requireAuth :
// Google y redirige le navigateur directement (simple navigation, sans notre en-tête
// Authorization). Son authenticité repose sur le state signé (voir googleDrive.js#verifyState),
// pas sur une session — c'est pourquoi il est monté avant router.use(requireAuth) ci-dessous.
router.get('/callback', async (req, res) => {
  const { code, state, error: googleError } = req.query;

  if (googleError) {
    return driveErrorRedirect(res, 'Connexion Google refusée ou annulée.');
  }

  const verified = verifyState(state);
  if (!verified || !code) {
    return driveErrorRedirect(res, 'Lien de connexion Google invalide ou expiré.');
  }

  const { tenantId, userId } = verified;

  try {
    const tokens = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      // Se produit si l'utilisateur avait déjà autorisé cette app par le passé et que Google,
      // malgré prompt: 'consent', ne renvoie pas de nouveau refresh_token pour ce compte —
      // rare mais possible. Sans refresh_token la connexion ne peut pas se renouveler dans la
      // durée : mieux vaut le dire clairement que stocker une connexion vouée à expirer.
      return driveErrorRedirect(res, "Google n'a pas renvoyé d'autorisation renouvelable — réessayez.");
    }

    // Récupère l'email du compte Google connecté (affiché côté Paramètres) via l'API userinfo,
    // authentifiée avec le token qu'on vient d'obtenir. Best-effort : purement informatif, donc
    // un échec ici (scope insuffisant, API temporairement indisponible...) ne doit jamais faire
    // échouer toute la connexion — juste afficher un email générique par défaut.
    let googleEmail = 'Compte connecté';
    try {
      const userInfoAuth = new google.auth.OAuth2();
      userInfoAuth.setCredentials({ access_token: tokens.access_token });
      const { data: userInfo } = await google.oauth2({ version: 'v2', auth: userInfoAuth }).userinfo.get();
      if (userInfo.email) googleEmail = userInfo.email;
    } catch (userInfoErr) {
      console.error("Échec de récupération de l'email du compte Google Drive connecté :", userInfoErr.message);
    }

    const rootFolderId = await createRootFolder(tokens.access_token);

    const { error: upsertError } = await supabase.from('google_drive_connections').upsert(
      {
        tenant_id: tenantId,
        google_email: googleEmail,
        access_token: encrypt(tokens.access_token),
        refresh_token: encrypt(tokens.refresh_token),
        token_expires_at: new Date(tokens.expiry_date).toISOString(),
        root_folder_id: rootFolderId,
        category_folder_ids: {},
        connected_by: userId,
      },
      { onConflict: 'tenant_id' }
    );

    if (upsertError) {
      console.error('Échec de stockage de la connexion Google Drive :', upsertError);
      return driveErrorRedirect(res, 'La connexion a réussi côté Google mais n\'a pas pu être enregistrée.');
    }

    // Ne bascule JAMAIS storage_provider ici : la connexion OAuth et l'activation du stockage
    // Drive pour les nouveaux documents sont deux étapes volontairement distinctes (voir
    // tenant_storage_settings) — l'admin doit confirmer explicitement le basculement ensuite.
    return res.redirect(`${process.env.FRONTEND_URL}/settings?drive=connected`);
  } catch (err) {
    console.error('Échec du callback OAuth Google Drive :', err);
    return driveErrorRedirect(res, 'Impossible de finaliser la connexion à Google Drive.');
  }
});

router.use(requireAuth);

// GET /api/drive/connect — génère l'URL de consentement Google (admin uniquement : seul un
// admin peut connecter le Drive de l'entreprise). Retourne l'URL plutôt que de rediriger
// directement : cet endpoint est appelé en XHR par le frontend (avec le Bearer token), donc
// une redirection HTTP serait suivie par axios, pas par le navigateur — c'est au frontend de
// faire `window.location = url` avec l'URL reçue.
router.get('/connect', requireRole('admin'), (req, res) => {
  try {
    const url = getAuthUrl(req.tenantId, req.user.id);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/drive/status — état de connexion actuel du tenant, jamais les tokens eux-mêmes.
router.get('/status', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('google_drive_connections')
    .select('google_email, root_folder_id, created_at')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer l\'état de la connexion Google Drive.' });
  }

  if (!data) {
    return res.json({ connected: false });
  }

  const { data: storageSettings } = await supabase
    .from('tenant_storage_settings')
    .select('storage_provider')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  res.json({
    connected: true,
    google_email: data.google_email,
    connected_at: data.created_at,
    storage_provider: storageSettings?.storage_provider || 'supabase',
  });
});

// POST /api/drive/activate — confirme le basculement vers Google Drive comme stockage des
// nouveaux documents. Étape volontairement séparée du callback OAuth (voir B2) : se connecter
// à Google ne doit jamais, à lui seul, changer où sont stockés les prochains documents — il
// faut une confirmation explicite de l'admin après avoir vu à quel compte il vient de se lier.
router.post('/activate', requireRole('admin'), async (req, res) => {
  const { data: connection, error: connectionError } = await supabase
    .from('google_drive_connections')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (connectionError) {
    return res.status(500).json({ error: 'Impossible de vérifier la connexion Google Drive.' });
  }
  if (!connection) {
    return res.status(400).json({ error: "Aucune connexion Google Drive à activer — connectez-vous d'abord." });
  }

  const { data, error } = await supabase
    .from('tenant_storage_settings')
    .upsert({ tenant_id: req.tenantId, storage_provider: 'google_drive' }, { onConflict: 'tenant_id' })
    .select('storage_provider')
    .single();

  if (error) {
    return res.status(500).json({ error: "Impossible d'activer Google Drive comme stockage." });
  }

  res.json(data);
});

// GET /api/drive/health — vérifie que la connexion peut encore être utilisée (rafraîchissement
// du token si besoin) sans faire d'appel Drive superflu. Un échec ici signifie typiquement un
// accès révoqué côté Google (compte déconnecté, app retirée) plutôt qu'un souci réseau ponctuel.
router.get('/health', requireRole('admin'), async (req, res) => {
  const { data: connection, error } = await supabase
    .from('google_drive_connections')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de vérifier la connexion Google Drive.' });
  }
  if (!connection) {
    return res.json({ healthy: false, connected: false });
  }

  try {
    await refreshAccessTokenIfNeeded(connection);
    res.json({ healthy: true });
  } catch (err) {
    console.error('Connexion Google Drive en échec (vérification de santé) :', err.message);
    res.json({ healthy: false, error: 'La connexion a expiré ou a été révoquée côté Google.' });
  }
});

// DELETE /api/drive/disconnect — supprime la connexion et repasse le tenant sur Supabase
// Storage pour les nouveaux documents. Les documents déjà stockés sur Drive restent référencés
// tels quels (storage_provider='google_drive' sur ces lignes n'est pas modifié) : ils ne sont
// plus accessibles en écriture via l'app après déconnexion, mais rien n'est supprimé côté Drive
// ni côté base.
router.delete('/disconnect', requireRole('admin'), async (req, res) => {
  const { error: deleteError } = await supabase.from('google_drive_connections').delete().eq('tenant_id', req.tenantId);

  if (deleteError) {
    return res.status(500).json({ error: 'Impossible de déconnecter Google Drive.' });
  }

  // Un UPDATE dont le filtre ne matche aucune ligne n'est pas une erreur côté Supabase (pas de
  // .single() ici) — si le tenant n'a jamais eu de ligne dans tenant_storage_settings, ce
  // update est un no-op silencieux, ce qui est le comportement voulu : l'absence de ligne
  // signifie déjà "supabase" par défaut (voir schema.sql).
  const { error: updateError } = await supabase
    .from('tenant_storage_settings')
    .update({ storage_provider: 'supabase' })
    .eq('tenant_id', req.tenantId);

  if (updateError) {
    return res.status(500).json({ error: 'Google Drive déconnecté, mais le paramétrage du stockage n\'a pas pu être remis à jour.' });
  }

  res.status(204).send();
});

export default router;
