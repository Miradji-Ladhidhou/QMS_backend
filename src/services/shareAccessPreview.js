import { effectiveSharePermissions } from './sharePermissions.js';

export function previewShareRights(rows, recipient, proposal) {
  const applies = (row) => (row.subject_type === 'user' && row.subject_id === recipient.id) ||
    (row.subject_type === 'role' && row.subject_id === recipient.role);
  const replacing = (row) => row.subject_type === proposal.subject_type && row.subject_id === proposal.subject_id;
  const current = rows.filter(applies);
  const proposed = { ...proposal, can_edit: proposal.can_edit, can_export: proposal.can_export };
  const next = [...current.filter((row) => !replacing(row)), proposed];
  const existing = current.find(replacing);
  return {
    current: effectiveSharePermissions(current),
    proposed: effectiveSharePermissions(next),
    duplicate: Boolean(existing && existing.can_edit === proposal.can_edit && existing.can_export === proposal.can_export),
    limited_by_other_share: next.some((row) => !replacing(row) &&
      ((proposal.can_edit && row.can_edit === false) || (proposal.can_export && row.can_export === false))),
  };
}
