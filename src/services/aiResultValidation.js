import { validateHaccpAiSuggestions } from './haccpAiValidation.js';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const texts = (value) => Array.isArray(value) && value.every(text);
const rating = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
const priorities = ['low', 'medium', 'high', 'critical'];

function capa(value) {
  return text(value?.synthesis) && texts(value.root_causes)
    && Array.isArray(value.suggested_actions) && value.suggested_actions.every((action) =>
      text(action.title) && text(action.description) && priorities.includes(action.suggested_priority))
    && texts(value.preventive_actions) && priorities.includes(value.overall_priority);
}

export function validAiResult(endpoint, value, input = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (endpoint.endsWith('/generate-full-draft')) return text(value.id) && text(value.subject);
  if (endpoint.includes('/qqoqccp/')) return text(value.ai_synthesis) && capa({ synthesis: value.ai_synthesis, ...value.ai_suggested_actions });
  if (endpoint.endsWith('/capa-suggestion')) return capa(value);
  if (endpoint.includes('/pdca/')) return text(value.content);
  if (endpoint.endsWith('/service-suggestion')) return Array.isArray(value.risks) && value.risks.length > 0
    && value.risks.every((risk) => text(risk.title) && ['risk', 'opportunity'].includes(risk.type) && rating(risk.likelihood) && rating(risk.impact));
  if (endpoint.endsWith('/risk-treatment-suggestion')) return text(value.treatment_plan) && rating(value.residual_likelihood) && rating(value.residual_impact);
  if (endpoint.endsWith('/hazard-suggestion')) return Array.isArray(value.hazards) && value.hazards.length > 0
    && value.hazards.every((hazard) => text(hazard.description) && ['biological', 'chemical', 'physical', 'allergen'].includes(hazard.hazard_type) && rating(hazard.likelihood) && rating(hazard.severity));
  if (endpoint.endsWith('/haccp-significance-suggestion')) return typeof value.is_significant === 'boolean'
    && ['undetermined', 'prp', 'ccp', 'process_change'].includes(value.control_type) && text(value.justification) && text(value.decision_justification);
  if (endpoint.endsWith('/haccp-ccp-suggestion')) return [
    'critical_limits', 'monitoring_procedure', 'monitoring_frequency', 'corrective_action_procedure',
    'verification_procedure', 'verification_frequency', 'record_keeping_procedure',
  ].every((key) => text(value[key]));
  if (endpoint.endsWith('/haccp-surveillance-suggestion')) {
    const hazardIds = input.steps?.flatMap((step) => step.hazards.map((hazard) => hazard.id)) || [];
    return hazardIds.length > 0 && validateHaccpAiSuggestions(value, hazardIds).issues.length === 0;
  }
  if (endpoint.endsWith('/checklist/generate')) return texts(value.questions) && value.questions.length > 0;
  if (endpoint.endsWith('/ai-draft')) return texts(value.decisions) && (text(value.conclusions) || text(value.improvement_opportunities) || value.decisions.length > 0);
  if (endpoint.endsWith('/ai-suggestion')) return Array.isArray(value.series) && value.series.length > 0
    && value.series.every((series) => text(series.label) && ['ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped'].includes(series.calc_type));
  if (endpoint.endsWith('/check-compliance')) return typeof value.compliant === 'boolean' && Array.isArray(value.anomalies)
    && value.anomalies.every((anomaly) => text(anomaly.section_key) && text(anomaly.issue) && ['minor', 'major', 'blocking'].includes(anomaly.severity));
  if (endpoint.endsWith('/compliance-fix')) return text(value.section_key) && text(value.corrected_content);
  if (endpoint.endsWith('/compare')) return text(value.summary) && Array.isArray(value.changes)
    && value.changes.every((change) => text(change.section_key) && text(change.description) && ['added', 'removed', 'modified'].includes(change.change_type));
  if (endpoint.endsWith('/distribution-sheet')) return Boolean(value.distribution_sheet) && text(value.distribution_sheet.summary);
  if (endpoint.endsWith('/suggest-revision-from-capa')) return text(value.rationale) && Array.isArray(value.suggested_changes)
    && value.suggested_changes.every((change) => text(change.section_key) && text(change.suggested_content));
  return Array.isArray(value.sections) && value.sections.length > 0
    && value.sections.every((section) => text(section.key) && text(section.label) && Array.isArray(section.blocks) && section.blocks.length > 0);
}
