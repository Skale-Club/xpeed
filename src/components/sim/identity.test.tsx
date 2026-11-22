// "One look for a game, a track and a car" (owner rule, 2026-11-21: XPD-D-IDENTITY; AGENTS.md). Wherever a Virtual screen names a game, a
// track or a car, its picture is beside the name, drawn by the one shared component and in one of the shared sizes:
//   a game   its cover:          GameCover (a picture), GameBadge (a head or a card), GameName (inside a line of text)
//   a track  its layout:         TrackLayoutThumb (found by the track's id) or TrackOutline (the layout already in hand)
//   a car    its brand's logo:   SimCarIdentity
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAR_LOGO, TRACK_THUMB } from './identity-sizes';
import { GameName } from './session-bits';

vi.mock('@/lib/sim/games', () => ({ useGames: () => ({ name: (id: string) => ({ lmu: 'Le Mans Ultimate' }[id] ?? id), cover: (id: string) => `/api/sim/games/${id}/cover` }) }));
afterEach(cleanup);

const root = join(process.cwd(), 'src');
const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((name) => {
  const path = `${dir}/${name}`;
  if (statSync(join(root, path)).isDirectory()) return files(path);
  return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
});
const screens = [...files('components/sim'), ...files('components/social')].map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));

describe('the sizes', () => {
  it('are one set for every screen: a row and a line for the brand logo, a row and a dense line for the track map', () => {
    expect(CAR_LOGO).toEqual({ row: 'h-7 w-10', line: 'h-5 w-7' });
    expect(TRACK_THUMB).toEqual({ row: 'h-11 w-11', dense: 'h-7 w-7' });
  });

  it('are not written again on a screen: a list row takes the default or a named size (a page header may be bigger)', () => {
    for (const { file, text } of screens) {
      // The brand logo: only a size bigger than a row (h-8 and up, a header) may be passed by hand.
      for (const [, size] of text.matchAll(/<SimCarIdentity[^>]*logoClassName="([^"]*)"/g)) expect(Number(size.match(/\bh-(\d+)/)?.[1] ?? 0), `${file}: logoClassName="${size}"`).toBeGreaterThan(7);
      // The track map: no row-sized map sized by hand (h-9 to h-12 is the row's own size, written once in identity-sizes.ts).
      for (const [, size] of text.matchAll(/<TrackLayoutThumb[^>]*className="([^"]*)"/g)) expect(size, file).not.toMatch(/(^|\s)h-(9|10|11|12)(\s|$)/);
    }
  });
});

describe('a game inside a line of text', () => {
  it('is its cover and its name, together', () => {
    render(<GameName game="lmu" />);
    const game = screen.getByTestId('session-game');
    expect(game).toHaveTextContent('Le Mans Ultimate');
    expect(game.querySelector('img')).toHaveAttribute('src', '/api/sim/games/lmu/cover');
  });
});

describe('the screens', () => {
  // Where a game's name is still written by hand, and why its cover is not (or is) beside it. A new file that writes a game's name must
  // use GameBadge or GameName, or be added here with its reason.
  const GAME_NAME_BY_HAND: Record<string, string> = {
    'components/sim/session-bits.tsx': 'GameBadge and GameName themselves',
    'components/sim/overview/Where.tsx': 'the games list: the cover beside each name',
    'components/sim/CompanionGames.tsx': 'the games of a computer: the cover beside each name',
    'components/sim/CarPage.tsx': 'the subtitle of the header, under the GameBadge',
    'components/sim/TrackLayouts.tsx': 'the layouts kept on this device (a file list)',
    'components/sim/SessionsList.tsx': 'the options of a filter (a drop-down holds text)',
    'components/sim/sessions/Filters.tsx': 'the chip of a filter',
    'components/sim/SimCars.tsx': 'the options of a filter',
    'components/sim/TracksList.tsx': 'the options of a filter',
    'components/sim/LapPicker.tsx': 'the options of a filter',
    'components/sim/SessionCoach.tsx': 'a sentence (the label of the conversation)',
    'components/sim/CompanionDevices.tsx': 'a sentence (what the computer is doing)',
    'components/social/board-browse.tsx': 'the page trail, the sorting, and the tabs (with the cover)',
    'components/social/RacingAdmin.tsx': 'the admin review of a report (plain facts)',
  };

  it('write the name of a game only through GameBadge or GameName (or are on the short list of reasons)', () => {
    const byHand = screens.filter(({ text }) => /\bgames\.name\(|\bgameName\(/.test(text)).map(({ file }) => file).sort();
    expect(byHand).toEqual(Object.keys(GAME_NAME_BY_HAND).sort());
  });

  it('draw a track with the shared map, never with a drawing of their own', () => {
    // TrackShape (garage/bits) is the big drawing of a track's own page; a list or a card uses TrackLayoutThumb or TrackOutline.
    const own = screens.filter(({ text }) => /<TrackShape\b/.test(text)).map(({ file }) => file).sort();
    expect(own).toEqual(['components/sim/TrackPage.tsx', 'components/sim/garage/bits.tsx'].filter((file) => screens.find((entry) => entry.file === file && /<TrackShape\b/.test(entry.text))));
    expect(own).not.toContain('components/sim/TracksList.tsx');
  });
});
