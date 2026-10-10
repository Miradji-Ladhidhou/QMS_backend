import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { sendEmail } from '../services/email.js';
import {
  GUEST_CODE_TTL_MINUTES,
  GUEST_CODE_RESEND_COOLDOWN_SECONDS,
  GUEST_EXPIRY_DAYS,
  GUEST_MAX_CODE_SENDS,
  GUEST_MAX_FAILED_ATTEMPTS,
  generateGuestCode,
  generateGuestToken,
  hashGuestCode,
  hashGuestToken,
  normalizeGuestEmail,
} from '../services/guestSharing.js';
import { SHAREABLE_RESOURCES } from '../services/shareableResources.js';
import { readGuestBundleItems } from '../services/guestShareSelection.js';
import { protectedFileUrl } from '../services/sharedFiles.js';

const router = Router();
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function findGuestShare(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const { data, error } = await supabase
    .from('guest_shares')
    .select('id, tenant_id, resource_type, resource_id, title, can_export, email, code_hash, code_expires_at, code_sends, code_sent_at, failed_attempts, access_token_hash, expires_at, revoked_at')
    .eq('token_hash', hashGuestToken(token))
    .maybeSingle();
  if (error) throw new Error(`Lecture du partage invité impossible : ${error.message}`);
  return data;
}

function shareState(share) {
  if (!share) return 'invalid';
  if (share.revoked_at) return 'revoked';
  if (new Date(share.expires_at) <= new Date()) return 'expired';
  if (share.failed_attempts >= GUEST_MAX_FAILED_ATTEMPTS) return 'locked';
  return 'valid';
}

export async function readSharedResource(share) {
  const { data, error } = await supabase
    .from(SHAREABLE_RESOURCES[share.resource_type].table)
    .select(SHAREABLE_RESOURCES[share.resource_type].fields)
    .eq('tenant_id', share.tenant_id)
    .eq('id', share.resource_id)
    .maybeSingle();
  if (error) throw new Error(`Lecture de la ressource partagée impossible : ${error.message}`);
  if (!data) return null;

  const readChildren = async (table, columns, foreignKey, id) => {
    const { data: rows, error: childError } = await supabase
      .from(table)
      .select(columns)
      .eq('tenant_id', share.tenant_id)
      .eq(foreignKey, id);
    if (childError) throw new Error(`Lecture des données associées au partage impossible : ${childError.message}`);
    return rows || [];
  };

  if (share.resource_type === 'procedure' && data.current_version_id) {
    const { data: version, error: versionError } = await supabase
      .from('procedure_versions')
      .select('version, content, status, validated_at')
      .eq('tenant_id', share.tenant_id)
      .eq('id', data.current_version_id)
      .maybeSingle();
    if (versionError) throw new Error(`Lecture de la version partagée impossible : ${versionError.message}`);
    data.current_version = version;
    delete data.current_version_id;
  }

  if (share.resource_type === 'audit') {
    const [findings, checklist] = await Promise.all([
      readChildren('audit_findings', 'type, description, created_at', 'audit_id', share.resource_id),
      readChildren('audit_checklist_items', 'position, question, answer, observation', 'audit_id', share.resource_id),
    ]);
    data.findings = findings;
    data.checklist = checklist;
  }

  if (share.resource_type === 'management_review') {
    data.actions = await readChildren(
      'management_review_actions',
      'description, due_date, status, completed_at, source',
      'review_id',
      share.resource_id
    );
  }

  if (share.resource_type === 'supplier') {
    data.evaluations = await readChildren(
      'supplier_evaluations',
      'evaluation_date, quality_score, delivery_score, price_score, responsiveness_score, overall_score, decision, comment',
      'supplier_id',
      share.resource_id
    );
    data.documents = await readChildren(
      'supplier_documents',
      'id, kind, title, reference, issuer, issued_on, expires_on, notes, file_name',
      'supplier_id',
      share.resource_id
    );
  }

  if (share.resource_type === 'haccp_plan') {
    const steps = await readChildren(
      'haccp_process_steps',
      'id, step_number, name, description',
      'plan_id',
      share.resource_id
    );
    data.steps = await Promise.all(steps.map(async (step) => {
      const hazards = await readChildren(
        'haccp_hazards',
        'id, hazard_type, description, existing_controls, likelihood, severity, risk_score, is_significant, justification, control_type, decision_justification',
        'step_id',
        step.id
      );
      const enrichedHazards = await Promise.all(hazards.map(async (hazard) => {
        const ccps = await readChildren(
          'haccp_ccps',
          'id, ccp_number, critical_limits, status, validation_source, validation_evidence, limit_min, limit_max, limit_unit, monitoring_procedure, monitoring_frequency, corrective_action_procedure, verification_procedure, verification_frequency, record_keeping_procedure',
          'hazard_id',
          hazard.id
        );
        const enrichedCcps = await Promise.all(ccps.map(async (ccp) => {
          const monitoringLogs = ccp.status === 'approved'
            ? await readChildren(
                'haccp_monitoring_logs',
                'recorded_value, numeric_value, within_limits, corrective_action_taken, lot_reference, product_disposition, disposition_decision, return_to_control, effectiveness_verification, recorded_at',
                'ccp_id',
                ccp.id
              )
            : [];
          const ccpDetails = { ...ccp };
          delete ccpDetails.id;
          return { ...ccpDetails, monitoring_logs: monitoringLogs };
        }));
        const hazardDetails = { ...hazard };
        delete hazardDetails.id;
        return { ...hazardDetails, ccps: enrichedCcps };
      }));
      return { step_number: step.step_number, name: step.name, description: step.description, hazards: enrichedHazards };
    }));
  }

  if (share.resource_type === 'kpi') {
    data.records = await readChildren('kpi_records', 'period_date, value, comment, source', 'kpi_id', share.resource_id);
  }

  return data;
}

// Ces routes sont publiques, mais chaque accès aux données exige à la fois le jeton du lien,
// le code à usage unique reçu par email et un jeton de session temporaire révocable.
router.use(noStore);

router.get('/:token', async (req, res) => {
  const share = await findGuestShare(req.params.token);
  const state = shareState(share);
  if (state !== 'valid' && state !== 'locked') {
    return res.status(state === 'expired' || state === 'revoked' ? 410 : 404).json({ state });
  }
  if (state === 'locked') return res.status(403).json({ state });

  const { data: tenant, error } = await supabase.from('tenants').select('name').eq('id', share.tenant_id).single();
  if (error) throw new Error(`Lecture de l'entreprise pour le partage invité impossible : ${error.message}`);
  res.json({ state, tenant_name: tenant.name, expires_at: share.expires_at });
});

router.post(
  '/:token/send-code',
  [body('email').trim().isEmail().withMessage('Saisissez l’adresse email à laquelle l’invitation a été envoyée.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const share = await findGuestShare(req.params.token);
    const state = shareState(share);
    if (state !== 'valid') {
      const status = state === 'expired' || state === 'revoked' ? 410 : state === 'locked' ? 403 : 404;
      return res.status(status).json({ state, error: 'Ce lien n’est plus disponible.' });
    }

    if (normalizeGuestEmail(req.body.email) !== share.email) {
      let attempts = share.failed_attempts;
      for (let retry = 0; retry < GUEST_MAX_FAILED_ATTEMPTS; retry += 1) {
        if (attempts >= GUEST_MAX_FAILED_ATTEMPTS) break;
        const { data: updated, error } = await supabase
          .from('guest_shares')
          .update({ failed_attempts: attempts + 1 })
          .eq('id', share.id)
          .eq('failed_attempts', attempts)
          .select('failed_attempts')
          .maybeSingle();
        if (error) throw new Error(`Mise à jour des tentatives du partage invité impossible : ${error.message}`);
        if (updated) {
          attempts = updated.failed_attempts;
          break;
        }
        const { data: current, error: readError } = await supabase
          .from('guest_shares')
          .select('failed_attempts')
          .eq('id', share.id)
          .single();
        if (readError) throw new Error(`Relecture des tentatives du partage invité impossible : ${readError.message}`);
        attempts = current.failed_attempts;
      }
      return res.status(403).json({
        state: attempts >= GUEST_MAX_FAILED_ATTEMPTS ? 'locked' : 'valid',
        error: attempts >= GUEST_MAX_FAILED_ATTEMPTS
          ? 'Trop de tentatives. Demandez un nouveau lien.'
          : `Cette adresse ne correspond pas à l’invitation. ${GUEST_MAX_FAILED_ATTEMPTS - attempts} essai(s) restant(s).`,
      });
    }

    if (share.code_sends >= GUEST_MAX_CODE_SENDS) {
      return res.status(429).json({ error: 'Le nombre maximal d’envois de code est atteint. Demandez un nouvel accès.' });
    }
    if (share.code_sent_at) {
      const secondsSinceLastSend = (Date.now() - new Date(share.code_sent_at).getTime()) / 1000;
      if (secondsSinceLastSend < GUEST_CODE_RESEND_COOLDOWN_SECONDS) {
        const retryAfter = Math.ceil(GUEST_CODE_RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
        return res.status(429).json({ error: `Réessayez dans ${retryAfter} seconde(s).` });
      }
    }

    const code = generateGuestCode();
    const codeExpiresAt = new Date(Date.now() + GUEST_CODE_TTL_MINUTES * 60 * 1000).toISOString();
    const { data: updated, error } = await supabase
      .from('guest_shares')
      .update({
        code_hash: hashGuestCode(code),
        code_expires_at: codeExpiresAt,
        code_sent_at: new Date().toISOString(),
        code_sends: share.code_sends + 1,
      })
      .eq('id', share.id)
      .eq('code_sends', share.code_sends)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Création du code pour le partage invité impossible : ${error.message}`);
    if (!updated) return res.status(409).json({ error: 'Un code vient d’être demandé. Rechargez la page et réessayez.' });

    const html = `<p>Voici votre code de vérification pour accéder en lecture seule aux données partagées depuis QMS SaaS.</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:5px">${escapeHtml(code)}</p>
      <p>Ce code est à usage unique et expire dans ${GUEST_CODE_TTL_MINUTES} minutes. Ne le transférez pas.</p>`;
    try {
      await sendEmail(share.email, 'Votre code de vérification — QMS SaaS', html);
    } catch (sendError) {
      const { error: cleanupError } = await supabase
        .from('guest_shares')
        .update({ code_hash: null, code_expires_at: null })
        .eq('id', share.id)
        .eq('code_hash', hashGuestCode(code));
      if (cleanupError) console.error('[guest-share] cleanup after code email failure failed:', cleanupError.message);
      throw sendError;
    }
    res.json({ sent: true });
  }
);

router.post(
  '/:token/verify',
  [body('code').isString().matches(/^\d{8}$/).withMessage('Saisissez le code à 8 chiffres reçu par email.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const share = await findGuestShare(req.params.token);
    const state = shareState(share);
    if (state !== 'valid') {
      const status = state === 'expired' || state === 'revoked' ? 410 : state === 'locked' ? 403 : 404;
      return res.status(status).json({ state, error: state === 'locked' ? 'Trop de codes erronés. Demandez un nouveau lien.' : 'Lien invalide ou expiré.' });
    }
    if (!share.code_hash || !share.code_expires_at || new Date(share.code_expires_at) <= new Date()) {
      return res.status(410).json({ state: 'code_expired', error: 'Le code a expiré. Demandez un nouveau lien à la personne qui vous l’a envoyé.' });
    }
    if (hashGuestCode(req.body.code) !== share.code_hash) {
      let attempts = share.failed_attempts;
      for (let retry = 0; retry < GUEST_MAX_FAILED_ATTEMPTS; retry += 1) {
        if (attempts >= GUEST_MAX_FAILED_ATTEMPTS) break;
        const { data: updated, error } = await supabase
          .from('guest_shares')
          .update({ failed_attempts: attempts + 1 })
          .eq('id', share.id)
          .eq('failed_attempts', attempts)
          .select('failed_attempts')
          .maybeSingle();
        if (error) throw new Error(`Mise à jour des tentatives du partage invité impossible : ${error.message}`);
        if (updated) {
          attempts = updated.failed_attempts;
          break;
        }

        const { data: current, error: readError } = await supabase
          .from('guest_shares')
          .select('failed_attempts')
          .eq('id', share.id)
          .single();
        if (readError) throw new Error(`Relecture des tentatives du partage invité impossible : ${readError.message}`);
        attempts = current.failed_attempts;
      }
      return res.status(403).json({
        state: attempts >= GUEST_MAX_FAILED_ATTEMPTS ? 'locked' : 'valid',
        error: attempts >= GUEST_MAX_FAILED_ATTEMPTS
          ? 'Trop de codes erronés. Demandez un nouveau lien.'
          : `Code incorrect. ${GUEST_MAX_FAILED_ATTEMPTS - attempts} essai(s) restant(s).`,
      });
    }

    const accessToken = generateGuestToken();
    const { data: activated, error } = await supabase
      .from('guest_shares')
      .update({ access_token_hash: hashGuestToken(accessToken), code_hash: null })
      .eq('id', share.id)
      .eq('code_hash', share.code_hash)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Activation du partage invité impossible : ${error.message}`);
    if (!activated) return res.status(409).json({ error: 'Ce code a déjà été utilisé. Rechargez la page et vérifiez votre email.' });

    const [{ data: tenant, error: tenantError }, resource] = await Promise.all([
      supabase.from('tenants').select('name').eq('id', share.tenant_id).single(),
      share.resource_type ? readSharedResource(share) : readGuestBundleItems(share),
    ]);
    if (tenantError) throw new Error(`Lecture de l'entreprise pour le partage invité impossible : ${tenantError.message}`);
    if (!resource) return res.status(404).json({ error: 'La donnée partagée n’existe plus.' });
    res.json({
      access_token: accessToken,
      tenant_name: tenant.name,
      ...(share.resource_type
        ? { resource_type: share.resource_type, resource }
        : { title: share.title, items: resource }),
      expires_at: share.expires_at,
      can_export: share.can_export,
    });
  }
);

async function requireGuestSession(req, res, next) {
  const share = await findGuestShare(req.params.token);
  const state = shareState(share);
  if (state !== 'valid') {
    return res.status(state === 'expired' || state === 'revoked' ? 410 : state === 'locked' ? 403 : 404)
      .json({ state, error: 'Ce partage n’est plus disponible.' });
  }
  const accessToken = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!accessToken || hashGuestToken(accessToken) !== share.access_token_hash) {
    return res.status(401).json({ error: 'Vérifiez le code reçu par email pour consulter ces données.' });
  }
  req.guestShare = share;
  next();
}

router.get('/:token/data', requireGuestSession, async (req, res) => {
  const share = req.guestShare;
  const resource = share.resource_type ? await readSharedResource(share) : await readGuestBundleItems(share);
  if (!resource) return res.status(404).json({ error: 'La donnée partagée n’existe plus.' });
  const { data: tenant, error } = await supabase.from('tenants').select('name').eq('id', share.tenant_id).single();
  if (error) throw new Error(`Lecture de l'entreprise pour le partage invité impossible : ${error.message}`);
  res.json({
    tenant_name: tenant.name, expires_at: share.expires_at, can_export: share.can_export,
    ...(share.resource_type ? { resource_type: share.resource_type, resource } : { title: share.title, items: resource }),
  });
});

router.get('/:token/items/:id', requireGuestSession, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const share = req.guestShare;
  if (share.resource_type) return res.status(404).json({ error: 'Élément absent de ce lot.' });
  const { data: item, error } = await supabase.from('guest_share_items')
    .select('resource_type, resource_id').eq('tenant_id', share.tenant_id)
    .eq('guest_share_id', share.id).eq('id', req.params.id).maybeSingle();
  if (error) throw new Error(`Lecture de l'élément du lot impossible : ${error.message}`);
  if (!item) return res.status(404).json({ error: 'Élément absent de ce lot.' });
  const resource = await readSharedResource({ ...share, ...item });
  if (!resource) return res.status(404).json({ error: 'Cet élément a été supprimé et n’est plus disponible.' });
  res.json({ resource_type: item.resource_type, resource, expires_at: share.expires_at, can_export: share.can_export });
});

async function guestExportTarget(req, res) {
  const share = req.guestShare;
  if (!share.can_export) {
    res.status(403).json({ code: 'SHARE_EXPORT_DENIED', error: 'Export et téléchargement interdits pour ce partage.' });
    return null;
  }
  if (share.resource_type) return share;
  const itemId = req.query.item_id;
  if (typeof itemId !== 'string' || !/^[0-9a-f-]{36}$/i.test(itemId)) {
    res.status(400).json({ error: 'Choisissez un élément du lot.' });
    return null;
  }
  const { data: item, error } = await supabase.from('guest_share_items').select('resource_type, resource_id')
    .eq('tenant_id', share.tenant_id).eq('guest_share_id', share.id).eq('id', itemId).maybeSingle();
  if (error) throw new Error(`Vérification de l'élément exporté impossible : ${error.message}`);
  if (!item) { res.status(404).json({ error: 'Élément absent de ce lot.' }); return null; }
  return { ...share, ...item };
}

router.get('/:token/export', requireGuestSession, async (req, res) => {
  const target = await guestExportTarget(req, res);
  if (!target) return;
  const resource = await readSharedResource(target);
  if (!resource) return res.status(404).json({ error: 'Élément supprimé.' });
  res.set('Content-Disposition', 'attachment; filename="donnees-partagees.json"');
  res.json({ resource_type: target.resource_type, resource });
});

router.get('/:token/download', requireGuestSession, async (req, res) => {
  const target = await guestExportTarget(req, res);
  if (!target) return;
  if (!['document', 'procedure', 'supplier'].includes(target.resource_type)) {
    return res.status(404).json({ error: 'Cet élément ne comporte pas de fichier téléchargeable.' });
  }
  if (target.resource_type === 'supplier') {
    const fileId = req.query.file_id;
    if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fileId)) return res.status(400).json({ error: 'Choisissez une pièce jointe.' });
    const { data: file, error: fileError } = await supabase.from('supplier_documents').select('id, file_path')
      .eq('tenant_id', target.tenant_id).eq('supplier_id', target.resource_id).eq('id', fileId).maybeSingle();
    if (fileError) throw new Error(`Vérification de la pièce fournisseur impossible : ${fileError.message}`);
    if (!file?.file_path) return res.status(404).json({ error: 'Pièce jointe indisponible.' });
    return res.json({ url: protectedFileUrl(req, { resourceType: 'supplier', resourceId: target.resource_id, versionId: file.id, guestShare: req.guestShare }) });
  }
  const config = SHAREABLE_RESOURCES[target.resource_type];
  const { data: record, error } = await supabase.from(config.table)
    .select(target.resource_type === 'document' ? 'file_path' : 'current_version_id')
    .eq('tenant_id', target.tenant_id).eq('id', target.resource_id).maybeSingle();
  if (error) throw new Error(`Vérification du fichier partagé impossible : ${error.message}`);
  if (!record || (target.resource_type === 'document' ? !record.file_path : !record.current_version_id)) {
    return res.status(404).json({ error: 'Aucun fichier disponible pour cet élément.' });
  }
  res.json({ url: protectedFileUrl(req, {
    resourceType: target.resource_type, resourceId: target.resource_id,
    versionId: record.current_version_id || null, guestShare: req.guestShare,
  }) });
});

export default router;
