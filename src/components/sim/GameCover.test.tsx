import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GameCover } from './GameCover';

function open(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ games: [{ key: 'ams2', title: 'Automobilista 2', cover: { type: 'image/jpeg', sha256: 'x', bytes: 1, path: '/api/sim/games/ams2/cover' } }] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the cover of a game', () => {
  it('is a portrait box, 2 : 3 like the covers (300 x 450), whose width comes from the caller', () => {
    open(<GameCover game="nogame" className="w-12" testId="cover" />);
    const box = screen.getByTestId('cover');
    expect(box).toHaveClass('aspect-[2/3]', 'w-12');
    // Never a square: no fixed height and no h-/w- pair of the same size.
    expect(box.className).not.toMatch(/\bh-\d/);
  });

  it('fills the same box with a controller icon for a game with no cover, so nothing jumps when one arrives', () => {
    open(<GameCover game="nogame" testId="cover" />);
    const box = screen.getByTestId('cover');
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('svg')).not.toBeNull();
    expect(box).toHaveClass('aspect-[2/3]');
  });

  it('shows the picture whole in that box (covered, not stretched), once the list of games is read', async () => {
    open(<GameCover game="ams2" testId="cover" />);
    await waitFor(() => expect(screen.getByTestId('cover').querySelector('img')).not.toBeNull());
    const image = screen.getByTestId('cover').querySelector('img')!;
    expect(image).toHaveClass('h-full', 'w-full', 'object-cover');
    expect(image.getAttribute('src')).toContain('/api/sim/games/ams2/cover');
    expect(image).toHaveAttribute('alt', '');
  });
});
