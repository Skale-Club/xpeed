import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import SharedReport from './SharedReport';
import i18n from '@/lib/i18n';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-extras', () => ({ getSharedReport: get }));
beforeAll(async () => { await i18n.changeLanguage('en'); });
beforeEach(() => get.mockReset());
afterEach(cleanup);
const report = (name: string) => ({ car: { name }, session: null, flags: [], active_dtcs: [] });
function Shell() { const navigate = useNavigate(); return <><button onClick={() => navigate('/share/b')}>Open B</button><SharedReport /></>; }
const mount = () => render(<MemoryRouter initialEntries={['/share/a']}><Routes><Route path="/share/:id" element={<Shell />} /></Routes></MemoryRouter>);

it('handles a rejected request and allows retry instead of staying on the loader', async () => {
  get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(report('Recovered report'));
  mount();
  expect(await screen.findByText('Report unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Recovered report')).toBeInTheDocument();
});

it('does not show a delayed report after navigating to a different link', async () => {
  let finish!: (data: ReturnType<typeof report>) => void;
  get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(report('Report B'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
  expect(await screen.findByText('Report B')).toBeInTheDocument();
  await act(async () => finish(report('Late report A')));
  expect(screen.queryByText('Late report A')).not.toBeInTheDocument();
  expect(screen.getByText('Report B')).toBeInTheDocument();
});
