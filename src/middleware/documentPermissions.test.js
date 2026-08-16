import { describe, it, expect, vi, beforeEach } from 'vitest';

// supabase.js throws at import time if env vars are missing, and we don't want real
// network calls anyway — on remplace tout le module par un mock configurable par test.
vi.mock('../services/supabase.js', () => ({ supabase: { from: vi.fn() } }));

const { supabase } = await import('../services/supabase.js');
const {
  hasCategoryPermission,
  filterViewableDocuments,
  filterViewableCategories,
} = await import('./documentPermissions.js');

// Fait de `supabase.from(table)` un builder chaînable et "thenable" : chaque appel
// consomme la prochaine réponse mise en file pour cette table, dans l'ordre où le code
// sous test les enchaîne (ex : document_categories, puis category_permissions direct,
// puis group_members, puis category_permissions groupe).
function mockSupabaseQueues(queues) {
  const state = Object.fromEntries(Object.entries(queues).map(([table, responses]) => [table, [...responses]]));

  supabase.from.mockImplementation((table) => {
    const resolve = () => {
      const queue = state[table];
      if (!queue || queue.length === 0) {
        throw new Error(`Aucune réponse simulée en file pour la table "${table}"`);
      }
      return queue.shift();
    };

    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      single: () => Promise.resolve(resolve()),
      then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('hasCategoryPermission', () => {
  it('accorde toujours l’accès à un admin, sans même interroger la base', async () => {
    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'admin',
      categoryId: 'c1',
      permission: 'view',
    });

    expect(allowed).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('accorde toujours l’accès à un owner, sans même interroger la base', async () => {
    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'owner',
      categoryId: 'c1',
      permission: 'delete',
    });

    expect(allowed).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('accorde l’accès sans requête si le document n’a pas de catégorie', async () => {
    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: null,
      permission: 'view',
    });

    expect(allowed).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('accorde l’accès si la catégorie n’est pas restreinte (comportement actuel inchangé)', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: { is_restricted: false }, error: null }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'view',
    });

    expect(allowed).toBe(true);
  });

  it('refuse un utilisateur sans aucune entrée de permission sur une catégorie restreinte', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: { is_restricted: true }, error: null }],
      category_permissions: [{ data: [], error: null }],
      group_members: [{ data: [], error: null }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'view',
    });

    expect(allowed).toBe(false);
  });

  it('accorde l’accès via une permission directe sur l’utilisateur', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: { is_restricted: true }, error: null }],
      category_permissions: [{ data: [{ can_view: true }], error: null }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'view',
    });

    expect(allowed).toBe(true);
  });

  it('refuse si l’entrée directe existe mais pour un autre droit (can_view sans can_edit)', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: { is_restricted: true }, error: null }],
      category_permissions: [{ data: [{ can_edit: false }], error: null }, { data: [], error: null }],
      group_members: [{ data: [], error: null }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'edit',
    });

    expect(allowed).toBe(false);
  });

  it('accorde l’accès via l’appartenance à un groupe autorisé', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: { is_restricted: true }, error: null }],
      category_permissions: [{ data: [], error: null }, { data: [{ can_approve: true }], error: null }],
      group_members: [{ data: [{ group_id: 'g1' }], error: null }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'approve',
    });

    expect(allowed).toBe(true);
  });

  it('refuse par prudence si la catégorie est introuvable', async () => {
    mockSupabaseQueues({
      document_categories: [{ data: null, error: { message: 'not found' } }],
    });

    const allowed = await hasCategoryPermission({
      tenantId: 't1',
      userId: 'u1',
      userRole: 'employee',
      categoryId: 'c1',
      permission: 'view',
    });

    expect(allowed).toBe(false);
  });
});

describe('filterViewableDocuments', () => {
  it('ne filtre rien pour un admin', async () => {
    const documents = [
      { id: 'd1', category_id: 'c1', category: { is_restricted: true } },
      { id: 'd2', category_id: null, category: null },
    ];

    const result = await filterViewableDocuments({ userId: 'u1', userRole: 'admin', documents });

    expect(result).toEqual(documents);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('ne filtre rien et n’interroge pas la base si aucune catégorie n’est restreinte', async () => {
    const documents = [
      { id: 'd1', category_id: 'c1', category: { is_restricted: false } },
      { id: 'd2', category_id: null, category: null },
    ];

    const result = await filterViewableDocuments({ userId: 'u1', userRole: 'employee', documents });

    expect(result).toEqual(documents);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('exclut un document d’une catégorie restreinte sans permission accordée', async () => {
    mockSupabaseQueues({
      category_permissions: [{ data: [], error: null }],
      group_members: [{ data: [], error: null }],
    });

    const documents = [
      { id: 'd1', category_id: 'restricted', category: { is_restricted: true } },
      { id: 'd2', category_id: 'open', category: { is_restricted: false } },
    ];

    const result = await filterViewableDocuments({ userId: 'u1', userRole: 'employee', documents });

    expect(result.map((d) => d.id)).toEqual(['d2']);
  });

  it('inclut un document d’une catégorie restreinte avec permission directe can_view', async () => {
    mockSupabaseQueues({
      category_permissions: [
        { data: [{ category_id: 'restricted', subject_type: 'user', subject_id: 'u1', can_view: true }], error: null },
      ],
      group_members: [{ data: [], error: null }],
    });

    const documents = [{ id: 'd1', category_id: 'restricted', category: { is_restricted: true } }];

    const result = await filterViewableDocuments({ userId: 'u1', userRole: 'employee', documents });

    expect(result.map((d) => d.id)).toEqual(['d1']);
  });

  it('inclut un document d’une catégorie restreinte via permission de groupe can_view', async () => {
    mockSupabaseQueues({
      category_permissions: [
        { data: [{ category_id: 'restricted', subject_type: 'group', subject_id: 'g1', can_view: true }], error: null },
      ],
      group_members: [{ data: [{ group_id: 'g1' }], error: null }],
    });

    const documents = [{ id: 'd1', category_id: 'restricted', category: { is_restricted: true } }];

    const result = await filterViewableDocuments({ userId: 'u1', userRole: 'employee', documents });

    expect(result.map((d) => d.id)).toEqual(['d1']);
  });
});

describe('filterViewableCategories', () => {
  it('ne filtre rien pour un admin', async () => {
    const categories = [{ id: 'c1', is_restricted: true }, { id: 'c2', is_restricted: false }];

    const result = await filterViewableCategories({ userId: 'u1', userRole: 'admin', categories });

    expect(result).toEqual(categories);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('n’interroge pas la base si aucune catégorie n’est restreinte', async () => {
    const categories = [{ id: 'c1', is_restricted: false }, { id: 'c2', is_restricted: false }];

    const result = await filterViewableCategories({ userId: 'u1', userRole: 'employee', categories });

    expect(result).toEqual(categories);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('masque une catégorie restreinte sans permission — absence naturelle, pas d’erreur', async () => {
    mockSupabaseQueues({
      category_permissions: [{ data: [], error: null }],
      group_members: [{ data: [], error: null }],
    });

    const categories = [{ id: 'restricted', is_restricted: true }, { id: 'open', is_restricted: false }];

    const result = await filterViewableCategories({ userId: 'u1', userRole: 'employee', categories });

    expect(result.map((c) => c.id)).toEqual(['open']);
  });

  it('garde une catégorie restreinte avec permission directe can_view', async () => {
    mockSupabaseQueues({
      category_permissions: [
        { data: [{ category_id: 'restricted', subject_type: 'user', subject_id: 'u1', can_view: true }], error: null },
      ],
      group_members: [{ data: [], error: null }],
    });

    const categories = [{ id: 'restricted', is_restricted: true }];

    const result = await filterViewableCategories({ userId: 'u1', userRole: 'employee', categories });

    expect(result.map((c) => c.id)).toEqual(['restricted']);
  });
});
