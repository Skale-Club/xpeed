import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { ModesProvider } from '@/contexts/ModesContext';
import { MODES_KEY } from '@/lib/modes';
import OnboardingWizard from './OnboardingWizard';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', user_metadata: { full_name: 'Sam' } }, updateName: vi.fn() }),
}));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ createCar: vi.fn(), updateCar: vi.fn() }) }));
vi.mock('@/components/CarQuestions', () => ({ CarQuestions: () => <p>Car questions</p> }));

const stored = () => JSON.parse(localStorage.getItem(`${MODES_KEY}:u1`) ?? 'null');

function renderWizard() {
  const onComplete = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ModesProvider><OnboardingWizard onComplete={onComplete} /></ModesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onComplete;
}
const start = () => fireEvent.click(screen.getByRole('button', { name: /get started/i }));
const next = () => fireEvent.click(screen.getByRole('button', { name: /continue/i }));

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('onboarding while Virtual is not built', () => {
  it('goes straight from hello to the car, as it always did', () => {
    renderWizard();
    start();
    expect(screen.getByText('Car questions')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});

describe('onboarding with Virtual', () => {
  beforeEach(() => vi.stubEnv('VITE_ENABLE_VIRTUAL', 'true'));

  it('asks what Xpeed is for, with the car first and already chosen', () => {
    renderWizard();
    start();
    const options = screen.getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('My real car'),
      expect.stringContaining('Racing games'),
      expect.stringContaining('Both'),
    ]);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the usual car flow for someone who stays on Real', () => {
    renderWizard();
    start();
    next();
    expect(stored()).toEqual(['real']);
    expect(screen.getByText('Car questions')).toBeInTheDocument();
  });

  it('gives both modes to someone who picks both, and still asks for the car', () => {
    renderWizard();
    start();
    fireEvent.click(screen.getByTestId('onboard-mode-both'));
    next();
    expect(stored()).toEqual(['real', 'virtual']);
    expect(screen.getByText('Car questions')).toBeInTheDocument();
  });

  it('skips the car and the adapter for someone who wants games only', () => {
    const onComplete = renderWizard();
    start();
    fireEvent.click(screen.getByTestId('onboard-mode-virtual'));
    next();
    expect(stored()).toEqual(['virtual']);
    expect(screen.queryByText('Car questions')).not.toBeInTheDocument();
    expect(screen.getByText('Your simulator')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /go to virtual/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('lets someone go back and change the choice', () => {
    renderWizard();
    start();
    fireEvent.click(screen.getByTestId('onboard-mode-virtual'));
    next();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    fireEvent.click(screen.getByTestId('onboard-mode-real'));
    next();
    expect(stored()).toEqual(['real']);
    expect(screen.getByText('Car questions')).toBeInTheDocument();
  });
});
