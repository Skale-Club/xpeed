import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CarPicture } from './CarPicture';
import type { VehicleVisual } from '@/lib/vehicle-visuals';

const h = vi.hoisted(() => ({ items: [] as VehicleVisual[], photo: vi.fn(), transparent: vi.fn() }));
vi.mock('@/lib/vehicle-visuals', async () => {
  const actual = await vi.importActual<typeof import('@/lib/vehicle-visuals')>('@/lib/vehicle-visuals');
  return { ...actual, loadVehicleVisuals: () => Promise.resolve(h.items) };
});
vi.mock('@/lib/car-photo', () => ({ carPhotoUrl: h.photo }));
vi.mock('@/lib/transparent-image', () => ({ isTransparentImage: h.transparent }));
vi.mock('./VehicleModelViewer', () => ({ VehicleModelViewer: () => <div data-testid="interactive-model" /> }));

const prius = { key: 'toyota-prius', make: 'Toyota', model: 'Prius', modelAliases: [], yearFrom: 2009, yearTo: 2015, modelPath: '/vehicle-visuals/toyota-prius.glb', posterPath: '/vehicle-visuals/toyota-prius.png', credit: { author: 'Doz3', sourceUrl: 'https://sketchfab.com', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Optimized for web' } };
const car = { name: '2010 Prius', make: 'Toyota', model: 'Prius', year: 2010 };
afterEach(() => { cleanup(); vi.useRealTimers(); h.items = [prius]; h.photo.mockReset(); h.transparent.mockReset(); });

it('shows the exact matching model with its transparent poster and required credit', async () => {
  h.items = [prius];
  render(<CarPicture car={car} interactive />);
  expect(await screen.findByTestId('vehicle-poster')).toHaveAttribute('src', `http://localhost:3000${prius.posterPath}`);
  expect(screen.getByTestId('interactive-model')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Model by Doz3' })).toHaveAttribute('href', 'https://sketchfab.com');
  expect(screen.getByRole('link', { name: 'License CC BY 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
});

it('renders nothing for a missing match or unknown year', async () => {
  h.items = [prius];
  const view = render(<CarPicture car={{ ...car, model: 'Prius Prime' }} />);
  await waitFor(() => expect(screen.queryByTestId('vehicle-poster')).toBeNull());
  view.rerender(<CarPicture car={{ ...car, year: null }} />);
  await waitFor(() => expect(screen.queryByTestId('vehicle-poster')).toBeNull());
  expect(screen.queryByTestId('car-silhouette')).toBeNull();
});

it('uses a private photo only after verifying real transparency in cutout mode', async () => {
  h.items = [prius];
  h.photo.mockResolvedValue('https://example.test/car.png');
  h.transparent.mockResolvedValue(true);
  render(<CarPicture car={{ ...car, photo_path: 'owner/photo.png' }} cutoutOnly />);
  expect(await screen.findByTestId('vehicle-cutout')).toHaveAttribute('src', 'https://example.test/car.png');
  expect(h.transparent).toHaveBeenCalledWith('https://example.test/car.png');
});

it('falls back to the catalog model when the owner photo is opaque or unavailable', async () => {
  h.items = [prius];
  h.photo.mockResolvedValue('https://example.test/car.jpg');
  h.transparent.mockResolvedValue(false);
  render(<CarPicture car={{ ...car, photo_path: 'owner/photo.jpg' }} interactive cutoutOnly />);
  expect(await screen.findByTestId('vehicle-poster')).toBeInTheDocument();
  expect(screen.queryByTestId('vehicle-cutout')).toBeNull();
});

it('keeps default owner photos and retries one expired signed URL', async () => {
  h.photo.mockResolvedValueOnce('https://example.test/expired.jpg').mockResolvedValueOnce('https://example.test/renewed.jpg');
  render(<CarPicture car={{ ...car, photo_path: 'owner/photo.jpg' }} />);
  const photo = await screen.findByTestId('car-photo');
  expect(photo).toHaveAttribute('src', 'https://example.test/expired.jpg');
  fireEvent.error(photo);
  expect(await screen.findByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/renewed.jpg');
});

it('hides a second failed photo and recovers after reconnecting', async () => {
  h.items = [];
  h.photo.mockResolvedValue('https://example.test/photo.jpg');
  render(<CarPicture car={{ ...car, photo_path: 'owner/photo.jpg' }} />);
  fireEvent.error(await screen.findByTestId('car-photo'));
  fireEvent.error(await screen.findByTestId('car-photo'));
  expect(screen.queryByTestId('car-photo')).toBeNull();
  fireEvent(window, new Event('online'));
  expect(await screen.findByTestId('car-photo')).toBeInTheDocument();
  expect(h.photo).toHaveBeenCalledTimes(3);
});

it('renews private photos before expiry and preserves them during a transient signing failure', async () => {
  vi.useFakeTimers();
  h.items = [];
  h.photo.mockResolvedValue('https://example.test/first.jpg');
  await act(async () => { render(<CarPicture car={{ ...car, photo_path: 'owner/photo.jpg' }} />); });
  h.photo.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(50 * 60_000); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/first.jpg');
  h.photo.mockResolvedValue('https://example.test/renewed.jpg');
  await act(async () => { fireEvent(document, new Event('visibilitychange')); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/renewed.jpg');
});

it('ignores an old private photo lookup after changing cars', async () => {
  let finish!: (url: string) => void;
  h.photo.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
  const view = render(<CarPicture car={{ ...car, photo_path: 'owner/first.png' }} />);
  h.photo.mockResolvedValue('https://example.test/second.png');
  view.rerender(<CarPicture car={{ ...car, photo_path: 'owner/second.png' }} />);
  expect(await screen.findByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/second.png');
  await act(async () => { finish('https://example.test/old.png'); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/second.png');
});
