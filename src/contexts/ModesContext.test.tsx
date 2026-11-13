import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { ModesProvider } from '@/contexts/ModesContext';
import { ModeSwitch } from '@/components/ModeSwitch';
import { ModeGate } from '@/components/ModeGate';
import { ModesCard } from '@/components/ModesCard';
import { MODES_KEY } from '@/lib/modes';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// The app frame needs every provider; the gate's own behaviour is what is tested here.
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div data-testid="app-layout">{children}</div> }));

const choose = (modes: string[]) => localStorage.setItem(`${MODES_KEY}:u1`, JSON.stringify(modes));
const stored = () => JSON.parse(localStorage.getItem(`${MODES_KEY}:u1`) ?? 'null');

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ModesProvider>
        <ModeSwitch />
        <Where />
        <Routes>
          <Route element={<ModeGate mode="real" />}>
            <Route path="/" element={<p>Real home</p>} />
            <Route path="/history" element={<p>Trips</p>} />
          </Route>
          <Route element={<ModeGate mode="virtual" />}>
            <Route path="/sim" element={<p>Virtual home</p>} />
          </Route>
          <Route path="/settings" element={<ModesCard />} />
        </Routes>
      </ModesProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_ENABLE_VIRTUAL', 'true');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the Real | Virtual switch', () => {
  it('does not exist for someone who only has the car', () => {
    renderApp('/');
    expect(screen.queryByTestId('mode-switch')).not.toBeInTheDocument();
    expect(screen.getByText('Real home')).toBeInTheDocument();
  });

  it('does not exist for someone with only racing games either', () => {
    choose(['virtual']);
    renderApp('/sim');
    expect(screen.queryByTestId('mode-switch')).not.toBeInTheDocument();
  });

  it('never appears while Virtual is not built, even if a choice was stored', () => {
    choose(['real', 'virtual']);
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'false');
    renderApp('/');
    expect(screen.queryByTestId('mode-switch')).not.toBeInTheDocument();
  });

  it('lists Real first and switches both ways', () => {
    choose(['real', 'virtual']);
    renderApp('/');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Real', 'Virtual']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Virtual' }));
    expect(screen.getByText('Virtual home')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/sim');
    expect(screen.getByRole('tab', { name: 'Virtual' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Real' }));
    expect(screen.getByText('Real home')).toBeInTheDocument();
  });

  it('brings each mode back to the screen it was on', () => {
    choose(['real', 'virtual']);
    renderApp('/history');
    fireEvent.click(screen.getByRole('tab', { name: 'Virtual' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/sim');
    fireEvent.click(screen.getByRole('tab', { name: 'Real' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/history');
  });
});

describe('the mode gates', () => {
  it('offers Racing games on a Virtual screen to someone who did not choose it, instead of leaving without a word', () => {
    renderApp('/sim');
    expect(screen.queryByText('Virtual home')).not.toBeInTheDocument();
    expect(screen.getByTestId('mode-offer')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toContainElement(screen.getByTestId('mode-offer'));
    expect(screen.getByText('Racing games is off')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/sim');

    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(screen.getByText('Virtual home')).toBeInTheDocument();
    expect(stored()).toEqual(['real', 'virtual']);
    expect(screen.getByTestId('mode-switch')).toBeInTheDocument();
  });

  it('goes home without turning anything on when the person says not now', () => {
    renderApp('/sim');
    fireEvent.click(screen.getByRole('link', { name: 'Not now' }));
    expect(screen.getByText('Real home')).toBeInTheDocument();
    expect(stored()).toBeNull();
  });

  it('offers Real car on a car screen to someone who chose only racing games', () => {
    choose(['virtual']);
    renderApp('/history');
    expect(screen.getByText('Real car is off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(screen.getByText('Trips')).toBeInTheDocument();
    expect(stored()).toEqual(['real', 'virtual']);
  });

  it('still sends a Virtual link home when this build has no Virtual', () => {
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'false');
    renderApp('/sim');
    expect(screen.queryByTestId('mode-offer')).not.toBeInTheDocument();
    expect(screen.getByText('Real home')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });
});

describe('the Modes card in Settings', () => {
  it('is absent while Virtual is not built', () => {
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'false');
    renderApp('/settings');
    expect(screen.queryByTestId('modes-card')).not.toBeInTheDocument();
  });

  it('starts with Real on and locked, and lets someone add Virtual', () => {
    renderApp('/settings');
    expect(screen.getByTestId('modes-card')).toBeInTheDocument();
    const real = screen.getByRole('switch', { name: 'Real car' });
    const virtual = screen.getByRole('switch', { name: 'Racing games' });
    expect(real).toBeChecked();
    expect(real).toBeDisabled();
    expect(virtual).not.toBeChecked();
    expect(screen.getByText('Keep at least one mode on.')).toBeInTheDocument();

    fireEvent.click(virtual);
    expect(stored()).toEqual(['real', 'virtual']);
    expect(screen.getByRole('switch', { name: 'Racing games' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Real car' })).not.toBeDisabled();
    expect(screen.getByTestId('mode-switch')).toBeInTheDocument();
  });

  it('turns Real off for someone who wants games only, keeping one mode on', () => {
    choose(['real', 'virtual']);
    renderApp('/settings');
    fireEvent.click(screen.getByRole('switch', { name: 'Real car' }));
    expect(stored()).toEqual(['virtual']);
    expect(screen.getByRole('switch', { name: 'Racing games' })).toBeDisabled();
    expect(screen.queryByTestId('mode-switch')).not.toBeInTheDocument();
  });
});
