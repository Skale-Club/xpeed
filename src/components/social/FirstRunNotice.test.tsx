import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { FirstRunNotice } from './FirstRunNotice';
import { PROFILE_NOTICE_KEY } from './social-utils';

const auth = vi.hoisted(() => ({ user: { id: 'ana' } as { id: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

const show = (route = '/virtual') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <FirstRunNotice />
    </MemoryRouter>,
  );

beforeEach(async () => {
  auth.user = { id: 'ana' };
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the first-run notice', () => {
  it('shows the first time, with a button to the profile settings', () => {
    show();
    const banner = screen.getByTestId('profile-notice');
    expect(banner).toHaveTextContent('Your racing profile is public by default. Choose who can see it.');
    expect(screen.getByTestId('profile-notice-go')).toHaveAttribute('href', '/virtual/profile');
  });

  it('is dismissible, and then it shows once: never again on this browser for this person', () => {
    const first = show();
    fireEvent.click(screen.getByTestId('profile-notice-dismiss'));
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
    expect(localStorage.getItem(`${PROFILE_NOTICE_KEY}:ana`)).toBe('1');
    first.unmount();
    show('/virtual/sessions'); // another page, a new visit
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
  });

  it('is gone after the person follows its button to the profile', () => {
    const first = show();
    fireEvent.click(screen.getByTestId('profile-notice-go'));
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
    first.unmount();
    show();
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
  });

  it('is kept per person: someone else on the same browser sees it', () => {
    localStorage.setItem(`${PROFILE_NOTICE_KEY}:ana`, '1');
    show();
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
    cleanup();
    auth.user = { id: 'bruno' };
    show();
    expect(screen.getByTestId('profile-notice')).toBeInTheDocument();
  });

  it('does not show on the profile and privacy pages, where the choice is already in front of the person', () => {
    show('/virtual/profile');
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
    cleanup();
    show('/virtual/privacy');
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
    expect(localStorage.getItem(`${PROFILE_NOTICE_KEY}:ana`)).toBeNull(); // not counted as seen
  });

  it('shows nothing to nobody', () => {
    auth.user = null;
    show();
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
  });

  it('survives storage that throws: it shows, and goes away for the visit when dismissed', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    show();
    expect(screen.getByTestId('profile-notice')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('profile-notice-dismiss'));
    expect(screen.queryByTestId('profile-notice')).not.toBeInTheDocument();
  });

  it('is translated', async () => {
    await i18n.changeLanguage('es-ES');
    show();
    expect(screen.getByTestId('profile-notice')).toHaveTextContent('Tu perfil de carreras es público por defecto');
  });
});
