import { QueryClient } from '@tanstack/react-query';

// A failure that says it is not worth repeating (the racing data API's `retryable: false`: signed out, a bad request) is not retried;
// anything else is tried once more.
const retry = (failureCount: number, error: unknown) => (error as { retryable?: unknown } | null)?.retryable !== false && failureCount < 1;

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry } } });
