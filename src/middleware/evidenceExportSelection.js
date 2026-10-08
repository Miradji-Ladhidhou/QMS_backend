const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidSelection() {
  const error = new Error('La sélection des photos à exporter est invalide.');
  error.statusCode = 400;
  return error;
}

export function parseEvidenceExportSelection(query) {
  const selections = new Map();
  if (query.evidenceSelections !== undefined) {
    if (typeof query.evidenceSelections !== 'string' || query.evidenceSelections.length > 50000) throw invalidSelection();
    let parsed;
    try {
      parsed = JSON.parse(query.evidenceSelections);
    } catch {
      throw invalidSelection();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 100) throw invalidSelection();
    for (const [key, ids] of Object.entries(parsed)) {
      const [moduleKey, recordId, extra] = key.split(':');
      if (!/^[a-z-]+$/.test(moduleKey) || !UUID_PATTERN.test(recordId || '') || extra !== undefined ||
          !Array.isArray(ids) || ids.length > 10 || ids.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
        throw invalidSelection();
      }
      selections.set(key, [...new Set(ids)]);
    }
  }
  let legacyIds;
  if (query.evidenceSelection !== undefined) {
    if (query.evidenceSelection !== 'true') throw invalidSelection();
    const rawIds = query.evidenceIds === undefined ? [] : Array.isArray(query.evidenceIds) ? query.evidenceIds : [query.evidenceIds];
    if (rawIds.some((id) => typeof id !== 'string')) throw invalidSelection();
    legacyIds = rawIds.flatMap((id) => id.split(',')).filter(Boolean);
    if (legacyIds.length > 10 || legacyIds.some((id) => !UUID_PATTERN.test(id))) throw invalidSelection();
    legacyIds = [...new Set(legacyIds)];
  }
  return { selections, legacyIds };
}

export function evidenceExportSelection(req, res, next) {
  try {
    req.evidenceExportSelection = parseEvidenceExportSelection(req.query);
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    return res.status(400).json({ error: error.message });
  }
  next();
}
