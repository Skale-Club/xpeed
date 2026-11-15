import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { installErrorReporter } from '@/lib/error-reporter';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error('render broke for maria@example.com');
}

describe('the error boundary', () => {
  it('shows the way out and reports the render error to Xpeed\'s own server, scrubbed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchSpy);
    const uninstall = installErrorReporter({ baseUrl: () => 'https://xpeed.test' });
    try {
      render(<ErrorBoundary><Broken /></ErrorBoundary>);
      expect(screen.getByRole('button', { name: /go to the start/i })).toBeInTheDocument();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://xpeed.test/api/client-errors');
      const body = JSON.parse(String(init.body)) as { message: string };
      expect(body.message).toContain('render broke for [email]');
      expect(String(init.body)).not.toContain('maria');
    } finally {
      uninstall();
    }
  });

  it('still shows the way out when no reporter is installed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
