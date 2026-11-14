import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsProvider } from '@/contexts/SettingsContext';
import SettingsPage from './SettingsPage';

const modes = vi.hoisted(() => ({ mode: 'virtual' }));
vi.mock('@/contexts/ModesContext', () => ({ useModes: () => ({ mode: modes.mode }) }));
vi.mock('@/components/social/PrivacyScreen', () => ({
  VisibilitySection: ({ withDataLink }: { withDataLink?: boolean }) => <div data-testid="visibility-option">{withDataLink ? 'with data link' : 'plain'}</div>,
}));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/McpTokensSection', () => ({ default: () => null }));
vi.mock('@/components/InstallApp', () => ({ AndroidAppDownload: () => null, IosAddToHome: () => null, IphoneNoBluetooth: () => null }));

afterEach(cleanup);
const open = () => render(<MemoryRouter><SettingsProvider><SettingsPage /></SettingsProvider></MemoryRouter>);

it('offers who can see the racing profile as one option in Settings, in Virtual mode', () => {
  modes.mode = 'virtual';
  open();
  expect(screen.getByTestId('settings-racing-profile')).toBeInTheDocument();
  expect(screen.getByTestId('visibility-option')).toHaveTextContent('with data link');
});

it('does not show the racing profile option in Real mode', () => {
  modes.mode = 'real';
  open();
  expect(screen.queryByTestId('settings-racing-profile')).not.toBeInTheDocument();
});
