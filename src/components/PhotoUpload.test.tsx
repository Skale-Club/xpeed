import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PhotoUpload from './PhotoUpload';
import i18n from '@/lib/i18n';

const h = vi.hoisted(() => ({ upload: vi.fn(), sign: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/db-extras', () => ({
  listSessionPhotos: h.list, uploadSessionPhoto: h.upload, getPhotoUrl: h.sign, deleteSessionPhoto: vi.fn(),
}));
beforeAll(() => i18n.changeLanguage('en'));
beforeEach(() => { vi.clearAllMocks(); h.list.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('attaches a video with its full incident description', async () => {
  h.upload.mockResolvedValue({ id: 'video', storage_path: 'user/trip/clip.mp4', caption: 'Temperature warning after 20 minutes' });
  h.sign.mockResolvedValue('https://example.test/signed-video');
  const { container } = render(<PhotoUpload sessionId="trip" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach photo or video' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: 'What happened? (optional)' }), { target: { value: 'Temperature warning after 20 minutes' } });
  const file = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
  await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', 'https://example.test/signed-video'));
  expect(h.upload).toHaveBeenCalledWith(file, 'trip', 'dashboard', 'Temperature warning after 20 minutes');
  expect(screen.getByText('Temperature warning after 20 minutes')).not.toHaveClass('truncate');
});
it('shows a newly uploaded photo without reloading the page', async () => {
  h.upload.mockResolvedValue({ id: 'photo', storage_path: 'user/trip/photo.png', caption: 'Warning light' });
  h.sign.mockResolvedValue('https://example.test/signed-photo');
  const { container } = render(<PhotoUpload sessionId="trip" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach photo or video' })).toBeEnabled());
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } });
  expect(await screen.findByRole('img', { name: 'Warning light' })).toHaveAttribute('src', 'https://example.test/signed-photo');
  expect(h.sign).toHaveBeenCalledWith('user/trip/photo.png');
});
it('keeps an upload that completes for A out of B after navigation', async () => {
  let complete!: (photo: unknown) => void;
  h.upload.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const { container, rerender } = render(<PhotoUpload sessionId="A" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach photo or video' })).toBeEnabled());
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'a.png', { type: 'image/png' })] } });
  rerender(<PhotoUpload sessionId="B" />);
  await act(async () => { complete({ id: 'A-photo', storage_path: 'A/photo.png', caption: 'A private photo' }); });
  expect(screen.queryByRole('img', { name: 'A private photo' })).not.toBeInTheDocument();
});
it('shows a recoverable list error instead of describing photos as absent', async () => {
  h.list.mockRejectedValueOnce(new Error('offline'));
  render(<PhotoUpload sessionId="trip" />);
  expect(await screen.findByRole('alert')).toHaveTextContent("Could not load the trip records");
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
it('renews private photo URLs while the page stays open', async () => {
  vi.useFakeTimers();
  h.list.mockResolvedValue([{ id: 'photo', storage_path: 'trip/photo.png', caption: 'Dashboard' }]);
  h.sign.mockResolvedValue('https://example.test/first');
  await act(async () => { render(<PhotoUpload sessionId="trip" />); });
  expect(screen.getByRole('img', { name: 'Dashboard' })).toHaveAttribute('src', 'https://example.test/first');
  h.sign.mockResolvedValue('https://example.test/renewed');
  await act(async () => { await vi.advanceTimersByTimeAsync(50 * 60_000); });
  expect(screen.getByRole('img', { name: 'Dashboard' })).toHaveAttribute('src', 'https://example.test/renewed');
});
