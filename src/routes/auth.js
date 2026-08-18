import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';

const router = Router();

function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
    body('fullName').trim().notEmpty().withMessage('Le nom complet est requis.'),
    body('companyName').trim().notEmpty().withMessage("Le nom de l'entreprise est requis."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { email, password, fullName, companyName } = req.body;

    // 1. Création de l'utilisateur dans Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      if (/already registered|already exists/i.test(authError.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création du compte.' });
    }

    const userId = authData.user.id;
    const baseSlug = slugify(companyName);

    // 2. Création du tenant, avec repli sur un slug suffixé en cas de collision
    let tenant = null;
    let tenantError = null;

    for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

      const { data, error } = await supabase
        .from('tenants')
        .insert({ name: companyName, slug })
        .select()
        .single();

      if (!error) {
        tenant = data;
      } else if (error.code === '23505') {
        tenantError = error;
      } else {
        tenantError = error;
        break;
      }
    }

    if (!tenant) {
      await supabase.auth.admin.deleteUser(userId);
      const message =
        tenantError?.code === '23505'
          ? "Impossible de générer un identifiant unique pour cette entreprise, réessayez."
          : "Erreur lors de la création de l'entreprise.";
      return res.status(tenantError?.code === '23505' ? 409 : 500).json({ error: message });
    }

    // 3. Création du profil utilisateur, rattaché au tenant, en tant qu'admin — c'est la
    // personne qui vient de créer l'entreprise, donc son seul membre à ce stade.
    const { error: profileError } = await supabase.from('users').insert({
      id: userId,
      tenant_id: tenant.id,
      full_name: fullName,
      role: 'admin',
    });

    if (profileError) {
      await supabase.from('tenants').delete().eq('id', tenant.id);
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
    }

    return res.status(201).json({
      user: { id: userId, email, fullName },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    });
  }
);

export default router;
