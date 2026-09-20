// Contenu d'une revue de direction, partagé par les exports (PDF, Word, Excel) et le brouillon IA : un
// seul endroit qui sait lire les données d'entrée (§9.3.2), les actions (§9.3.3) et leur statut, pour
// que les trois documents et l'IA disent exactement la même chose que la page.

export const ACTION_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
export const ACTION_STATUS_LABELS = { open: 'À faire', in_progress: 'En cours', done: 'Réalisée', cancelled: 'Abandonnée' };
const FINDING_LABELS = { major_nc: 'NC majeures', minor_nc: 'NC mineures', observation: 'Observations', strength: 'Points forts' };
const RISK_LABELS = { low: 'Faible', medium: 'Moyen', high: 'Élevé', critical: 'Critique' };
const DISPOSITION_LABELS = { correction: 'Correction', segregation: 'Isolement', return_to_supplier: 'Retour fournisseur', concession: 'Dérogation', scrap: 'Rebut', other: 'Autre' };
const SEVERITY_LABELS = { minor: 'Mineur', moderate: 'Modéré', severe: 'Grave', fatal: 'Mortel' };
const TREND_LABELS = { up: 'en hausse', down: 'en baisse', stable: 'stable' };

const today = () => new Date().toISOString().slice(0, 10);
const formatDate = (value) => (value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR') : '—');

// Statut effectif d'une action : celui saisi, sauf qu'une action dont la CAPA liée est clôturée est
// considérée réalisée (derived = true : la page l'indique, le responsable n'a pas à le saisir deux
// fois). overdue : échéance dépassée alors que l'action n'est ni réalisée ni abandonnée.
export function effectiveActionStatus(action, now = today()) {
  let status = action.status || 'open';
  let derived = false;
  if (status !== 'done' && status !== 'cancelled' && action.linked_capa?.status === 'closed') {
    status = 'done';
    derived = true;
  }
  const overdue = Boolean(action.due_date) && action.due_date < now && status !== 'done' && status !== 'cancelled';
  return { status, derived, overdue };
}

export function enrichActions(actions, now = today()) {
  return actions.map((action) => {
    const { status, derived, overdue } = effectiveActionStatus(action, now);
    return { ...action, effective_status: status, status_derived: derived, is_overdue: overdue };
  });
}

// « Décrire la mise en œuvre » : ligne de texte d'une action, utilisée pour le suivi écrit des actions de
// la revue précédente et pour le contexte de l'IA.
export function describeAction(action) {
  const owner = action.owner_user?.full_name;
  const parts = [ACTION_STATUS_LABELS[action.effective_status || action.status] || action.status];
  if (action.status_derived) parts.push('CAPA liée clôturée');
  if (owner) parts.push(`responsable : ${owner}`);
  if (action.due_date) parts.push(`échéance ${formatDate(action.due_date)}${action.is_overdue ? ' (dépassée)' : ''}`);
  if (action.linked_capa) parts.push(`CAPA ${action.linked_capa.number}`);
  return `${action.description} — ${parts.join(', ')}`;
}

// Blocs « éléments d'entrée » de la revue : [{ title, lines[] }]. Deux sources : input_snapshot (période
// choisie : KPI, audits, réclamations, CAPA, risques) et snapshot (état du SMQ figé à la clôture).
export function buildInputBlocks(review) {
  const blocks = [];
  const input = review.input_snapshot;
  if (input?.period) {
    blocks.push({
      title: `Période analysée : du ${formatDate(input.period.start)} au ${formatDate(input.period.end)}`,
      lines: [],
    });
    blocks.push({
      title: 'KPI suivis',
      lines:
        (input.kpi_trend || []).length === 0
          ? ['Aucun KPI.']
          : input.kpi_trend.map((kpi) => {
              const value = kpi.current_avg !== null && kpi.current_avg !== undefined ? `${Number(kpi.current_avg).toFixed(1)}${kpi.unit ? ` ${kpi.unit}` : ''}` : '—';
              const target = kpi.target !== null && kpi.target !== undefined ? ` (objectif ${kpi.target_direction === 'max' ? '≤' : '≥'} ${kpi.target}${kpi.unit ? ` ${kpi.unit}` : ''})` : '';
              return `${kpi.name} : ${value}${target}${kpi.trend ? `, ${TREND_LABELS[kpi.trend] || kpi.trend}` : ''}`;
            }),
    });
    blocks.push({
      title: 'Audits internes',
      lines: [
        `${input.audits_period?.count ?? 0} audit(s) sur la période`,
        ...Object.entries(input.audits_period?.findings_by_type || {}).map(([type, count]) => `${FINDING_LABELS[type] || type} : ${count}`),
      ],
    });
    blocks.push({
      title: 'Réclamations clients',
      lines: [`${input.complaints_period?.received ?? 0} reçue(s), dont ${input.complaints_period?.still_open ?? 0} encore ouverte(s)`],
    });
    const rate = input.capas_period?.on_time_closure_rate;
    blocks.push({
      title: 'CAPA',
      lines: [
        `${input.capas_period?.in_progress ?? 0} en cours, ${input.capas_period?.closed_in_period ?? 0} clôturée(s) sur la période`,
        `Taux de clôture dans les délais : ${rate === null || rate === undefined ? '—' : `${rate} %`}`,
      ],
    });
    blocks.push({
      title: 'Risques actuellement ouverts',
      lines: [Object.entries(input.risks_open || {}).map(([level, count]) => `${RISK_LABELS[level] || level} : ${count}`).join(' · ') || 'Aucun'],
    });
  }

  // Éléments d'entrée complémentaires (absents des revues créées avant leur ajout).
  if (input?.satisfaction_period) {
    const sat = input.satisfaction_period;
    blocks.push({
      title: 'Satisfaction client',
      lines:
        sat.count === 0
          ? ['Aucune enquête sur la période.']
          : [`${sat.count} enquête(s), note moyenne ${sat.average_score}/5`, `${sat.satisfied_rate} % de clients satisfaits (note ≥ 4)`],
    });
  }
  if (input?.suppliers_period) {
    const sup = input.suppliers_period;
    blocks.push({
      title: 'Performance des fournisseurs',
      lines: [
        `${sup.active} fournisseur(s) actif(s), ${sup.evaluations} évaluation(s) sur la période${sup.average_score !== null ? `, note moyenne ${sup.average_score}/5` : ''}`,
        `Sous surveillance : ${sup.under_watch} · À remplacer : ${sup.to_replace} · Évaluations en retard : ${sup.overdue_evaluations}`,
      ],
    });
  }
  if (input?.nonconforming_period) {
    const nc = input.nonconforming_period;
    const dispositions = Object.entries(nc.by_disposition || {}).map(([key, count]) => `${DISPOSITION_LABELS[key] || key} : ${count}`);
    blocks.push({
      title: 'Sorties non conformes',
      lines: [`${nc.detected} détectée(s) sur la période, dont ${nc.still_open} encore ouverte(s)`, ...(dispositions.length > 0 ? [dispositions.join(' · ')] : [])],
    });
  }
  if (input?.accidents_period) {
    const acc = input.accidents_period;
    const severities = Object.entries(acc.by_severity || {}).map(([key, count]) => `${SEVERITY_LABELS[key] || key} : ${count}`);
    blocks.push({
      title: 'Accidents',
      lines: [
        `${acc.count} accident(s) sur la période, dont ${acc.with_lost_time} avec arrêt de travail (${acc.lost_days} jour(s) perdu(s)), ${acc.still_open} non clôturé(s)`,
        ...(severities.length > 0 ? [severities.join(' · ')] : []),
      ],
    });
  }
  if (input?.competences) {
    const comp = input.competences;
    blocks.push({
      title: 'Compétences et formations',
      lines: [
        comp.compliance_rate === null ? 'Aucune formation enregistrée.' : `${comp.compliance_rate} % de formations à jour (${comp.records_tracked} suivies : ${comp.to_renew} à renouveler sous 60 jours, ${comp.expired} échue(s))`,
        comp.auditors.designated
          ? `Auditeurs internes : ${comp.auditors.qualified} qualifié(s), ${comp.auditors.to_recycle} à recycler, ${comp.auditors.not_qualified} non qualifié(s)`
          : "Auditeurs internes : aucune formation qualifiante désignée",
      ],
    });
  }
  if (input?.quality_policy) {
    const policy = input.quality_policy;
    blocks.push({
      title: 'Politique qualité',
      lines: policy.defined
        ? [`Version en vigueur du ${formatDate(policy.last_updated)}`, `Lue par ${policy.acknowledged} utilisateur(s) actif(s) sur ${policy.users}`]
        : ["Aucune politique qualité publiée."],
    });
  }

  const snap = review.snapshot;
  if (snap) {
    blocks.push({
      title: `État du SMQ à la clôture (capturé le ${snap.generated_at ? new Date(snap.generated_at).toLocaleString('fr-FR') : '—'})`,
      lines: [
        `CAPA ouvertes : ${(snap.capas?.open ?? 0) + (snap.capas?.in_progress ?? 0)} dont ${snap.capas?.overdue ?? 0} en retard`,
        `Audits en cours : ${(snap.audits?.planned ?? 0) + (snap.audits?.in_progress ?? 0)}`,
        `KPI hors objectif : ${snap.kpis?.off_target ?? 0}`,
        `Documents à réviser : ${snap.documents?.to_review ?? 0}`,
        `Formations à renouveler : ${snap.trainings?.to_renew ?? 0}`,
      ],
    });
  }
  return blocks;
}

// Rubriques rédigées de la revue (§9.3.2/§9.3.3), dans l'ordre de la page.
export const REVIEW_TEXT_SECTIONS = [
  { key: 'previous_actions_status', title: 'Statut des actions de la revue précédente' },
  { key: 'context_changes', title: 'Évolutions du contexte' },
  { key: 'resource_adequacy', title: 'Adéquation des ressources' },
  { key: 'improvement_opportunities', title: "Opportunités d'amélioration" },
  { key: 'conclusions', title: 'Conclusions et décisions' },
];

export function formatReviewDate(value) {
  return formatDate(value);
}

// « Validée et signée électroniquement par Marie Durand le 20/09/2026 à 14:03 » — null si la revue n'est pas validée.
export function describeValidation(validation) {
  if (!validation) return null;
  const when = new Date(validation.validated_at).toLocaleString('fr-FR');
  return `Validée et signée par ${validation.validated_by_name || 'la direction'} le ${when}. Signature manuscrite électronique recueillie sur l'application.`;
}
