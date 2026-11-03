interface PageResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

const PAGE_SIZE = 500;

/** Read a complete ordered list, without silently accepting PostgREST's response-row cap. */
export async function readAllPages<T extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>,
  failureMessage: string,
): Promise<T[]> {
  const all: T[] = [];
  let previousLast: string | undefined;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${failureMessage}: ${error.message}`);
    const page = (data ?? []) as T[];
    if (page.length === 0) return all;
    const last = page[page.length - 1].id;
    if (last === previousLast) throw new Error(`${failureMessage}: pagination did not advance`);
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
    previousLast = last;
  }
}
