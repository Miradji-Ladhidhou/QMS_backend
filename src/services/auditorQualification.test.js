import { describe, it, expect } from 'vitest';
import { classifyRecord, resolveQualifications } from './auditorQualification.js';

const TODAY = '2026-09-20';
const TRAININGS = [{ id: 't1', title: 'Audit interne ISO 9001' }, { id: 't2', title: 'Audit interne HACCP' }];
const rec = (over) => ({ id: 'r', training_id: 't1', user_id: 'u1', completed_at: '2026-01-10', next_due_date: null, evaluation_result: null, ...over });

describe('classifyRecord', () => {
  it('à jour (sans échéance, échéance future ou aujourd\'hui) = qualifié', () => {
    expect(classifyRecord(rec({}), TODAY)).toBe('qualified');
    expect(classifyRecord(rec({ next_due_date: '2028-01-10' }), TODAY)).toBe('qualified');
    expect(classifyRecord(rec({ next_due_date: TODAY }), TODAY)).toBe('qualified');
  });
  it('échéance dépassée = à recycler', () => {
    expect(classifyRecord(rec({ next_due_date: '2026-09-19' }), TODAY)).toBe('expired');
  });
  it('évaluation/QCM échoué = non qualifié, même avec une échéance lointaine ; réussi ou non évalué = pas d\'effet', () => {
    expect(classifyRecord(rec({ evaluation_result: false, next_due_date: '2030-01-01' }), TODAY)).toBe('failed');
    expect(classifyRecord(rec({ evaluation_result: false, next_due_date: '2020-01-01' }), TODAY)).toBe('failed');
    expect(classifyRecord(rec({ evaluation_result: true }), TODAY)).toBe('qualified');
    expect(classifyRecord(rec({ evaluation_result: null }), TODAY)).toBe('qualified');
  });
});

describe('resolveQualifications', () => {
  const resolve = (records, attempts = []) => resolveQualifications({ trainings: TRAININGS, records, attempts, today: TODAY });

  it('personne sans réalisation : absente du résultat (= aucune qualification)', () => {
    expect(resolve([])).toEqual({});
  });

  it('seule la DERNIÈRE réalisation d\'une formation compte (un ancien échec ne pèse plus après un recyclage réussi)', () => {
    const result = resolve([
      rec({ id: 'old', completed_at: '2024-01-01', evaluation_result: false }),
      rec({ id: 'new', completed_at: '2026-03-01', evaluation_result: true, next_due_date: '2029-03-01' }),
    ]);
    expect(result.u1).toMatchObject({ status: 'qualified', completed_at: '2026-03-01' });
    // Et l'inverse : une ancienne réussite ne sauve pas un échec plus récent.
    const reversed = resolve([
      rec({ id: 'old', completed_at: '2024-01-01', evaluation_result: true }),
      rec({ id: 'new', completed_at: '2026-03-01', evaluation_result: false }),
    ]);
    expect(reversed.u1.status).toBe('failed');
  });

  it('plusieurs formations qualifiantes : la meilleure situation l\'emporte (qualifié > à recycler > échoué)', () => {
    const result = resolve([
      rec({ id: 'a', training_id: 't1', next_due_date: '2025-01-01' }), // expiré
      rec({ id: 'b', training_id: 't2', evaluation_result: false }), // échoué
    ]);
    expect(result.u1).toMatchObject({ status: 'expired', training_id: 't1', training_title: 'Audit interne ISO 9001' });

    const withValid = resolve([
      rec({ id: 'a', training_id: 't1', next_due_date: '2025-01-01' }),
      rec({ id: 'c', training_id: 't2', completed_at: '2026-02-02' }),
    ]);
    expect(withValid.u1).toMatchObject({ status: 'qualified', training_id: 't2', training_title: 'Audit interne HACCP' });
  });

  it('chaque personne est évaluée séparément', () => {
    const result = resolve([rec({ user_id: 'u1' }), rec({ id: 'x', user_id: 'u2', next_due_date: '2020-01-01' }), rec({ id: 'y', user_id: 'u3', evaluation_result: false })]);
    expect(Object.fromEntries(Object.entries(result).map(([id, q]) => [id, q.status]))).toEqual({ u1: 'qualified', u2: 'expired', u3: 'failed' });
  });

  it('joint le score du dernier QCM passé pour cette réalisation', () => {
    const result = resolve(
      [rec({ id: 'r1' })],
      [
        { record_id: 'r1', score_percent: 40, completed_at: '2026-01-11T10:00:00Z' },
        { record_id: 'r1', score_percent: 90, completed_at: '2026-01-12T10:00:00Z' },
        { record_id: 'autre', score_percent: 10, completed_at: '2026-01-13T10:00:00Z' },
      ]
    );
    expect(result.u1.quiz_score_percent).toBe(90);
    expect(resolve([rec({ id: 'r2' })]).u1.quiz_score_percent).toBeNull();
  });
});
