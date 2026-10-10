import { describe, expect, it } from 'vitest';
import { previewShareRights } from './shareAccessPreview.js';

const recipient = { id: 'member-id', role: 'member' };
const proposal = { subject_type: 'user', subject_id: recipient.id, can_edit: true, can_export: true };
describe('Aperçu des droits de partage', () => {
  it('remplace la règle du même destinataire au lieu de conserver sa restriction précédente', () => {
    const result = previewShareRights([{ ...proposal, can_edit: false, can_export: false }], recipient, proposal);
    expect(result.current.can_edit).toBe(false);
    expect(result.proposed.can_edit).toBe(true);
    expect(result.proposed.can_export).toBe(true);
    expect(result.duplicate).toBe(false);
  });
  it('détecte un doublon exact', () => {
    expect(previewShareRights([proposal], recipient, proposal).duplicate).toBe(true);
  });
  it('conserve les restrictions du rôle et ignore les droits des autres utilisateurs', () => {
    const result = previewShareRights([
      { subject_type: 'role', subject_id: 'member', can_edit: false, can_export: false },
      { ...proposal, subject_id: 'someone-else', can_edit: false },
    ], recipient, proposal);
    expect(result.proposed).toMatchObject({ can_edit: false, can_export: false });
    expect(result.limited_by_other_share).toBe(true);
  });
  it('un ancien partage sans restriction ne limite pas une autorisation explicite', () => {
    const result = previewShareRights([
      { subject_type: 'role', subject_id: 'member', can_edit: null, can_export: null },
    ], recipient, proposal);
    expect(result.proposed).toMatchObject({ can_edit: true, can_export: true });
    expect(result.limited_by_other_share).toBe(false);
  });
});
