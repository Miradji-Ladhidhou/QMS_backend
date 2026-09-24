export function requestedPagination(query, defaultLimit = 25, maxLimit = 100) {
  const hasPagination = query.page !== undefined || query.limit !== undefined;
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { enabled: hasPagination, page, limit };
}

export function paginateArray(items, { page, limit }) {
  const total = items.length;
  const total_pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, total_pages);
  const start = (safePage - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    pagination: { page: safePage, limit, total, total_pages },
  };
}

export function sendPaginatedOrArray(res, items, query, options) {
  const pagination = requestedPagination(query, options?.defaultLimit, options?.maxLimit);
  if (!pagination.enabled) return res.json(items);
  const result = paginateArray(items, pagination);
  return res.json(result);
}
