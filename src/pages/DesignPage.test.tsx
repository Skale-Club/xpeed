import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import DesignPage from '@/pages/DesignPage';

const admin = vi.hoisted(() => ({ status: { isAdmin: true, loading: false } }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => admin.status }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const SECTION_TITLES = ['Dashboards 2027', 'Colours', 'Type', 'Radius & elevation', 'Buttons', 'Badges & chips', 'Stats', 'Navigation', 'Filters', 'States', 'Form controls'];

const renderPage = () => render(<MemoryRouter><DesignPage /></MemoryRouter>);

beforeEach(async () => {
  admin.status = { isAdmin: true, loading: false };
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

describe('DesignPage', () => {
  it('shows every section and a few component samples to an admin', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Design system' })).toBeTruthy();
    for (const title of SECTION_TITLES) expect(screen.getByRole('heading', { level: 3, name: title })).toBeTruthy();
    expect(screen.getAllByTestId('swatch').length).toBeGreaterThan(40);
    expect(screen.getByText('--brand')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Period md' })).toBeTruthy();
    expect(screen.getByText('Could not load sessions')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Example switch' })).toBeTruthy();
  });

  it('shows the Dashboards 2027 preview on the Virtual Overview only, with no mode switch and nothing of the RC car', async () => {
    renderPage();
    // The preview loads the chart library on its own; under a full test run that can take a while.
    await screen.findByTestId('d27-preview', {}, { timeout: 15000 });
    expect(screen.getByTestId('d27-hero')).toHaveAttribute('data-size', 'hero');
    expect(screen.getByTestId('d27-hero-value')).toHaveTextContent('6');
    expect(screen.queryByRole('radiogroup', { name: 'Sample mode' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'RC' })).toBeNull();
  }, 20000);

  it('renders nothing of the page for a non-admin', () => {
    admin.status = { isAdmin: false, loading: false };
    renderPage();
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Design system' })).toBeNull();
    expect(screen.queryByText('Colours')).toBeNull();
    expect(screen.queryByTestId('swatch')).toBeNull();
  });
});
