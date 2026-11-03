import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import OAuthAuthorize from './OAuthAuthorize';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u', email: 'test@example.test' }, loading: false }) }));
afterEach(cleanup);
function mount(redirect: string) {
  const params = new URLSearchParams({ client_id: 'client', redirect_uri: redirect, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  return render(<MemoryRouter initialEntries={[`/oauth/authorize?${params}`]}><Routes><Route path="/oauth/authorize" element={<OAuthAuthorize />} /><Route path="/" element={<p>Local home</p>} /></Routes></MemoryRouter>);
}

it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'http://external.example/callback', 'not a URL'])('does not offer consent controls for an unsafe redirect %s', (redirect) => {
  mount(redirect);
  expect(screen.getByText('Invalid redirect URI')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
});

it('cancels locally instead of redirecting to an unverified client URL', () => {
  mount('https://unknown.example/callback');
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  expect(screen.getByText('Local home')).toBeInTheDocument();
});
