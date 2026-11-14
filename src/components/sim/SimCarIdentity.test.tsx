import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SimCarIdentity } from './SimCarIdentity';

vi.mock('@/lib/car-brands', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/car-brands')>();
  return { ...original, fetchCarBrands: async () => [{ key: 'ford', name: 'Ford', aliases: [], logo: { type: 'image/png', sha256: 'a'.repeat(64), bytes: 1, path: '/logo' } }] };
});
afterEach(cleanup);

describe('SimCarIdentity', () => {
  it('keeps the car name unchanged and uses a matching brand logo', async () => {
    render(<QueryClientProvider client={new QueryClient()}><SimCarIdentity name="Ford GT" /></QueryClientProvider>);
    expect(await screen.findByText('Ford GT')).toBeInTheDocument();
    expect(screen.getByTestId('sim-car-identity').querySelector('img')).toHaveAttribute('src', expect.stringContaining('/ford/logo'));
  });
  it('sizes the logo as the page asks (a page header wants it big, a table small), 24 px by default', async () => {
    const { rerender } = render(<QueryClientProvider client={new QueryClient()}><SimCarIdentity name="Ford GT" /></QueryClientProvider>);
    const logo = async () => (await screen.findByText('Ford GT')).parentElement!.querySelector('img')!.parentElement!;
    expect((await logo()).className).toMatch(/\bh-6 w-6\b/);
    rerender(<QueryClientProvider client={new QueryClient()}><SimCarIdentity name="Ford GT" logoClassName="h-12 w-12" /></QueryClientProvider>);
    await vi.waitFor(async () => expect((await logo()).className).toMatch(/\bh-12 w-12\b/));
    expect((await logo()).className).not.toMatch(/\bh-6\b/);
  });
  it('keeps unknown names unchanged and uses the generic icon', async () => {
    render(<QueryClientProvider client={new QueryClient()}><SimCarIdentity name="Sample Car" /></QueryClientProvider>);
    expect(await screen.findByText('Sample Car')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
