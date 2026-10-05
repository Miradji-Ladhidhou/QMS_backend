import { DEFAULT_RESOURCE_GROUPS } from './moduleResourceDefaults.js';

export const RESOURCE_SETTING_KEY = 'useful_links';

export function validateResourceGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== DEFAULT_RESOURCE_GROUPS.length) {
    return { error: 'Les rubriques de liens utiles sont invalides.' };
  }
  const ids = new Set();
  const normalized = [];
  for (const definition of DEFAULT_RESOURCE_GROUPS) {
    const group = groups.find((item) => item?.id === definition.id);
    if (!group || ids.has(group.id) || !Array.isArray(group.resources) || group.resources.length > 50) {
      return { error: 'Chaque rubrique doit être présente et contenir au maximum 50 liens.' };
    }
    ids.add(group.id);
    const resources = [];
    const urls = new Set();
    for (const resource of group.resources) {
      if (!resource || typeof resource.label !== 'string' || typeof resource.source !== 'string' ||
          typeof resource.url !== 'string') {
        return { error: 'Chaque lien doit comporter un titre, une source et une adresse HTTPS.' };
      }
      const label = resource.label.trim();
      const source = resource.source.trim();
      const url = resource.url.trim();
      if (!label || label.length > 200 || !source || source.length > 200 || !url || url.length > 2048 ||
          /[\u0000-\u0020\u007f]/.test(url)) {
        return { error: 'Titre et source : 1 à 200 caractères ; adresse : 1 à 2048 caractères sans espace.' };
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { error: 'Adresse de lien invalide. Utilisez une adresse HTTPS complète.' };
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) {
        return { error: 'Les liens doivent utiliser HTTPS, sans identifiants dans leur adresse.' };
      }
      if (urls.has(parsed.href)) return { error: 'Un lien existe déjà avec cette adresse dans la rubrique.' };
      urls.add(parsed.href);
      resources.push({ label, source, url: parsed.href });
    }
    normalized.push({ ...definition, resources });
  }
  return { groups: normalized };
}

export async function readResourceCatalog(database, settingKey = RESOURCE_SETTING_KEY) {
  const { data, error } = await database.from('platform_settings')
    .select('value, updated_at').eq('key', settingKey).maybeSingle();
  if (error) throw new Error(`Impossible de charger les liens utiles : ${error.message}`);
  // Avant la première publication, le catalogue initial reste disponible sans écriture à la lecture.
  if (!data) return { groups: DEFAULT_RESOURCE_GROUPS, updated_at: null };
  const result = validateResourceGroups(data.value?.groups);
  if (result.error) throw new Error(`Catalogue de liens utiles enregistré invalide : ${result.error}`);
  return { groups: result.groups, updated_at: data.updated_at };
}

export async function writeResourceCatalog(database, { groups, updatedAt, actorId }, settingKey = RESOURCE_SETTING_KEY) {
  const record = {
    value: { groups },
    updated_by: actorId,
    updated_at: new Date(Math.max(Date.now(), updatedAt === null ? 0 : Date.parse(updatedAt) + 1)).toISOString(),
  };
  const query = updatedAt === null
    ? database.from('platform_settings').insert({ key: settingKey, ...record })
    : database.from('platform_settings').update(record).eq('key', settingKey).eq('updated_at', updatedAt);
  return query.select('value, updated_at').maybeSingle();
}
