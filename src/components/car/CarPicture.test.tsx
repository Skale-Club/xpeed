import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CarPicture } from './CarPicture';

const sign = vi.hoisted(() => vi.fn());
vi.mock('@/lib/car-photo', () => ({ carPhotoUrl: sign }));
const car = { name: 'Car', photo_path: 'owner/car.png' };
beforeEach(() => { vi.useFakeTimers(); sign.mockReset().mockResolvedValue('https://example.test/first'); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('renews a car photo before its signed URL expires', async () => {
  await act(async () => { render(<CarPicture car={car} />); });
  sign.mockResolvedValue('https://example.test/renewed');
  await act(async () => { await vi.advanceTimersByTimeAsync(50 * 60_000); });
  expect(sign).toHaveBeenLastCalledWith(car.photo_path, true);
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/renewed');
});

it('renews after returning from a suspended tab and keeps the photo on signing failure', async () => {
  await act(async () => { render(<CarPicture car={car} />); });
  sign.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(50 * 60_000); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/first');
  sign.mockResolvedValue('https://example.test/returned');
  await act(async () => { fireEvent(document, new Event('visibilitychange')); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/returned');
});

it('retries a failed image once and recovers when connectivity returns', async () => {
  await act(async () => { render(<CarPicture car={car} />); });
  sign.mockResolvedValue('https://example.test/retry');
  await act(async () => { fireEvent.error(screen.getByTestId('car-photo')); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/retry');
  await act(async () => { fireEvent.error(screen.getByTestId('car-photo')); });
  expect(screen.queryByTestId('car-photo')).toBeNull();
  expect(sign).toHaveBeenCalledTimes(2);
  sign.mockResolvedValue('https://example.test/online');
  await act(async () => { fireEvent(window, new Event('online')); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/online');
});

it('ignores a previous car signing request after switching cars', async () => {
  let complete!: (url: string) => void;
  sign.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const view = render(<CarPicture car={car} />);
  sign.mockResolvedValue('https://example.test/other');
  await act(async () => { view.rerender(<CarPicture car={{ ...car, photo_path: 'other/car.png' }} />); });
  await act(async () => { complete('https://example.test/previous'); });
  expect(screen.getByTestId('car-photo')).toHaveAttribute('src', 'https://example.test/other');
});
