import { useEffect } from 'react';

/** The names a drop-down offers come from a catalog that may span pages: the rest is read by itself (this is not a visible list). */
export function useReadAllPages(query: { hasNextPage: boolean; isFetching: boolean; fetchNextPage: () => unknown; data?: { pages: unknown[] } }, maxPages = 10) {
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (query.hasNextPage && !query.isFetching && pages < maxPages) void query.fetchNextPage();
  }, [query, pages, maxPages]);
}
