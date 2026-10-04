const CONTROL_TYPES = ['undetermined', 'prp', 'ccp', 'process_change'];
const TEXT_FIELDS = [
  'justification', 'decision_justification', 'routine_monitoring', 'routine_frequency',
  'critical_limits', 'monitoring_procedure', 'monitoring_frequency',
  'corrective_action_procedure', 'verification_procedure', 'verification_frequency',
  'record_keeping_procedure',
];

export function validateHaccpAiSuggestions(response, hazardIds) {
  const issues = [];
  const knownIds = new Set(hazardIds);
  const seenIds = new Set();
  const suggestions = [];
  if (typeof response?.summary !== 'string') issues.push('summary: expected string');
  if (!Array.isArray(response?.suggestions)) {
    return { suggestions, issues: [...issues, 'suggestions: expected array'] };
  }
  response.suggestions.forEach((item, index) => {
    const prefix = `suggestions[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${prefix}: expected object`);
      return;
    }
    const itemIssues = [];
    if (!knownIds.has(item.hazard_id)) itemIssues.push('hazard_id: unknown');
    if (seenIds.has(item.hazard_id)) itemIssues.push('hazard_id: duplicate');
    seenIds.add(item.hazard_id);
    if (typeof item.is_significant !== 'boolean') itemIssues.push('is_significant: expected boolean');
    if (!CONTROL_TYPES.includes(item.control_type)) itemIssues.push('control_type: invalid');
    for (const field of TEXT_FIELDS) {
      if (typeof item[field] !== 'string') itemIssues.push(`${field}: expected string`);
    }
    if (typeof item.decision_justification === 'string' && item.decision_justification.trim().length < 8) {
      itemIssues.push('decision_justification: minimum 8 characters');
    }
    if (item.control_type !== 'ccp') {
      for (const field of ['routine_monitoring', 'routine_frequency']) {
        if (typeof item[field] === 'string' && !item[field].trim()) itemIssues.push(`${field}: required for non-CCP`);
      }
    }
    issues.push(...itemIssues.map((issue) => `${prefix}.${issue}`));
    if (!itemIssues.length) {
      suggestions.push({ ...item, justification: item.justification || item.decision_justification });
    }
  });
  for (const id of knownIds) {
    if (!seenIds.has(id)) issues.push(`hazard_id ${id}: missing suggestion`);
  }
  return { suggestions, issues };
}
