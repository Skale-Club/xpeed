import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { resetCompanionShell } from '@/lib/companion-shell';

// Heavy neighbours are stubbed: what is tested is which of them AppLayout renders.
vi.mock('@/contexts/ModesContext', () => ({ useModes: () => ({ mode: 'virtual', modes: ['real', 'virtual'], virtualAvailable: true }) }));
vi.mock('@/contexts/PageRefreshContext', () => ({ usePageRefresh: () => ({ refresh: async () => undefined }) }));
vi.mock('@/components/AppSidebar', () => ({ AppSidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('@/components/ChatBubble', () => ({ ChatBubble: () => <div data-testid="chat" /> }));
vi.mock('@/components/InstallPrompt', () => ({ InstallPrompt: () => <div data-testid="install" /> }));
vi.mock('@/components/AppUpdateBanner', () => ({ AppUpdateBanner: () => <div data-testid="update" /> }));
vi.mock('@/components/MobileTabBar', () => ({ MobileTabBar: () => <div data-testid="tabbar" /> }));
vi.mock('@/components/trip/NewCarDialog', () => ({ NewCarDialog: () => null }));
vi.mock('@/components/ModeSwitch', () => ({ ModeSwitch: () => <div data-testid="mode-switch" /> }));
vi.mock('@/components/header/HeaderControls', () => ({ HeaderControls: () => null }));
vi.mock('@/components/header/PageTrail', () => ({ PageTrail: () => <div data-testid="trail" /> }));
vi.mock('@/components/header/QuickNav', () => ({ QuickNav: () => <div data-testid="quicknav" /> }));
vi.mock('@/components/sim/CompanionStatus', () => ({ CompanionStatus: () => null }));
vi.mock('@/components/sim/Example', () => ({ ExampleBanner: () => <div data-testid="example" /> }));

const renderLayout = () => render(<MemoryRouter><AppLayout><p>Page content</p></AppLayout></MemoryRouter>);

beforeEach(() => { sessionStorage.clear(); resetCompanionShell(); window.history.replaceState(null, '', '/virtual/sessions'); });
afterEach(cleanup);

describe('AppLayout in shell mode', () => {
  it('shows only the content, the example banner and the assistant', () => {
    sessionStorage.setItem('xpeed.shell', 'companion');
    const { container } = renderLayout();
    expect(screen.getByText('Page content')).toBeInTheDocument();
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.getByTestId('example')).toBeInTheDocument();
    for (const id of ['sidebar', 'tabbar', 'install', 'update', 'mode-switch', 'trail', 'quicknav']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(container.querySelector('header')).toBeNull();
  });

  it('keeps the normal frame when shell mode is off', () => {
    const { container } = renderLayout();
    expect(screen.getByText('Page content')).toBeInTheDocument();
    for (const id of ['sidebar', 'tabbar', 'install', 'update', 'mode-switch', 'trail', 'quicknav', 'chat']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(container.querySelector('header')).not.toBeNull();
  });
});
