import { describe, expect, it } from 'vitest';
import { validateHaccpAiSuggestions } from './haccpAiValidation.js';

const hazardId = '8728f32a-d4b7-46b2-8ebd-dec3aba830af';
const item = {
  hazard_id: hazardId,
  is_significant: true,
  control_type: 'undetermined',
  decision_justification: 'Les preuves de maîtrise doivent être documentées.',
  justification: '',
  routine_monitoring: 'Documenter les preuves manquantes.',
  routine_frequency: 'Avant la décision de maîtrise.',
  critical_limits: '',
  monitoring_procedure: '',
  monitoring_frequency: '',
  corrective_action_procedure: '',
  verification_procedure: '',
  verification_frequency: '',
  record_keeping_procedure: '',
};
const validate = (suggestions) => validateHaccpAiSuggestions({ summary: 'Analyse', suggestions }, [hazardId]);

describe('Validation des réponses IA HACCP', () => {
  it('accepte une décision à instruire sans inventer de limites CCP', () => {
    const result = validate([item]);
    expect(result.issues).toEqual([]);
    expect(result.suggestions[0].justification).toBe(item.decision_justification);
    expect(result.suggestions[0].critical_limits).toBe('');
  });

  it.each([null, {}, 'invalid'])('signale une réponse mal structurée %j', (response) => {
    expect(validateHaccpAiSuggestions(response, [hazardId]).issues).toContain('suggestions: expected array');
  });

  it.each([
    [null, 'expected object'],
    [{ ...item, routine_frequency: '' }, 'routine_frequency: required for non-CCP'],
    [{ ...item, critical_limits: null }, 'critical_limits: expected string'],
    [{ ...item, monitoring_procedure: undefined }, 'monitoring_procedure: expected string'],
    [{ ...item, decision_justification: 'court' }, 'decision_justification: minimum 8 characters'],
    [{ ...item, is_significant: 'true' }, 'is_significant: expected boolean'],
    [{ ...item, control_type: 'invalid' }, 'control_type: invalid'],
    [{ ...item, hazard_id: 'unknown' }, 'hazard_id: unknown'],
  ])('diagnostique les champs rejetés sans renvoyer le contenu généré', (invalid, reason) => {
    expect(validate([invalid]).issues.join('; ')).toContain(reason);
  });

  it('refuse les dangers oubliés, doublons et suggestions étrangères même avec une couverture complète', () => {
    expect(validate([]).issues).toContain(`hazard_id ${hazardId}: missing suggestion`);
    expect(validate([item, item]).issues.join('; ')).toContain('hazard_id: duplicate');
    expect(validate([item, { ...item, hazard_id: 'unknown' }]).issues.join('; ')).toContain('hazard_id: unknown');
  });

  it('autorise les champs de routine vides uniquement pour les CCP', () => {
    expect(validate([{ ...item, control_type: 'ccp', routine_monitoring: '', routine_frequency: '' }]).issues).toEqual([]);
  });
});
