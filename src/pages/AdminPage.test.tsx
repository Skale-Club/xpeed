import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import AdminPage from './AdminPage';

const admin = vi.hoisted(() => ({ status: { isAdmin: false, loading: false } }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => admin.status }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AIProviderSection', () => ({ default: () => <div>AI provider settings</div> }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  admin.status = { isAdmin: false, loading: false };
});

describe('AdminPage', () => {
  it('says only "Not available" to someone who is not an admin', () => {
    render(<AdminPage />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/@/); // no e-mail address
    expect(text).not.toMatch(/UPDATE|SELECT|is_admin|car_profiles|SQL/i); // no SQL, no table names
    expect(screen.queryByText('AI provider settings')).not.toBeInTheDocument();
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<AdminPage />);
    expect(screen.getByText('Indisponível')).toBeInTheDocument();
    await i18n.changeLanguage('en');
  });

  it('shows the panel to an admin', () => {
    admin.status = { isAdmin: true, loading: false };
    render(<AdminPage />);
    expect(screen.getByText('AI provider settings')).toBeInTheDocument();
  });
});
