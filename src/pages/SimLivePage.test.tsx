import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { sampleFrame } from '@/components/sim/live/live-fixture';
import type { LiveFrame } from '@/lib/sim/live-frame';
import type { LiveState } from '@/lib/sim/use-live-stream';
import { PhoneLiveCard } from '@/components/sim/live/PhoneLiveCard';
import SimLivePage from './SimLivePage';

const stream = vi.hoisted(() => ({ value: { state: 'connecting', frame: null } as { state: string; frame: unknown } }));
vi.mock('@/lib/sim/use-live-stream', () => ({ useLiveStream: () => stream.value }));

const set = (state: LiveState, frame: LiveFrame | null = null) => { stream.value = { state, frame }; };

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}
const open = () => render(
  <MemoryRouter initialEntries={['/virtual/live']}>
    <Routes>
      <Route path="/virtual/live" element={<SimLivePage />} />
      <Route path="/virtual/companion" element={<p>Companion page</p>} />
      <Route path="/login" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  set('connecting');
});
afterEach(cleanup);

describe('the phone view', () => {
  it('draws the rows of a frame, with the dashboard name, the real Xpeed mark and the Live state', () => {
    set('live', sampleFrame());
    open();
    expect(screen.getByTestId('live-dashboard-name')).toHaveTextContent('Race');
    expect(screen.getByTestId('live-state')).toHaveTextContent('Live');
    expect(screen.getByRole('img', { name: 'Xpeed' })).toHaveAttribute('src', '/logo.svg');
    expect(screen.getByTestId('live-dashboard')).toBeInTheDocument();
    expect(document.querySelector('[data-widget="times"]')).not.toBeNull();
    expect(document.querySelector('[data-widget="relative"]')).not.toBeNull();
    expect(screen.queryByTestId('live-waiting')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
  });

  it('says it is waiting for the Companion, and what to turn on, while nothing is sent', () => {
    set('idle');
    open();
    expect(screen.getByTestId('live-state')).toHaveTextContent('Waiting for the Companion');
    expect(screen.getByTestId('live-waiting')).toHaveTextContent('Show the panel on my phone');
    expect(screen.queryByTestId('live-dashboard')).toBeNull();
  });

  it('shows the same calm screen while it first connects', () => {
    set('connecting');
    open();
    expect(screen.getByTestId('live-state')).toHaveTextContent('Connecting');
    expect(screen.getByTestId('live-waiting')).toBeInTheDocument();
  });

  it('keeps the last frame under a banner while it reconnects', () => {
    set('reconnecting', sampleFrame());
    open();
    expect(screen.getByTestId('live-state')).toHaveTextContent('Reconnecting');
    expect(screen.getByTestId('live-reconnecting')).toBeInTheDocument();
    expect(screen.getByTestId('live-dashboard')).toBeInTheDocument();
  });

  it('names a dashboard it does not know from its id', () => {
    set('live', sampleFrame({ dashboard: 'drift_day' }));
    open();
    expect(screen.getByTestId('live-dashboard-name')).toHaveTextContent('Drift day');
  });

  it('goes to the normal sign-in, and comes back here, when the session is gone', () => {
    set('signin');
    open();
    expect(screen.getByTestId('where')).toHaveTextContent('/login?next=%2Fvirtual%2Flive');
  });

  it('speaks Portuguese and Spanish', async () => {
    set('idle');
    await i18n.changeLanguage('pt-BR');
    const { unmount } = open();
    expect(screen.getByTestId('live-state')).toHaveTextContent('Esperando o Companion');
    unmount();
    await i18n.changeLanguage('es-ES');
    open();
    expect(screen.getByTestId('live-state')).toHaveTextContent('Esperando al Companion');
  });
});

describe('the card on the Companion page', () => {
  it('links to the phone view and says what to turn on in the Companion', () => {
    render(<MemoryRouter><PhoneLiveCard /></MemoryRouter>);
    expect(screen.getByTestId('companion-phone-open')).toHaveAttribute('href', '/virtual/live');
    expect(screen.getByTestId('companion-phone')).toHaveTextContent('Show the panel on my phone');
  });
});
