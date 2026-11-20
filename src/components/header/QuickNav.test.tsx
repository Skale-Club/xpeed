import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QuickNav } from './QuickNav';

vi.mock('@/contexts/ModesContext', () => ({ useModes: () => ({ mode: 'virtual', hasBoth: true }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ advancedTools: false }) }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => ({ isAdmin: false, loading: false }) }));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

afterEach(cleanup);

describe('QuickNav', () => {
  const renderIt = () => render(<MemoryRouter initialEntries={['/virtual']}><QuickNav /><Routes><Route path="*" element={<Where />} /></Routes></MemoryRouter>);

  it('opens with Ctrl K, filters the pages of the mode and goes to the one picked with Enter', () => {
    renderIt();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox');
    expect(screen.getAllByRole('option').length).toBe(7);
    fireEvent.change(input, { target: { value: 'friend' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('where')).toHaveTextContent('/virtual/friends');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says so when no page matches, and lists no admin page for a driver', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('quick-nav-open'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'admin' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No page with that name.')).toBeInTheDocument();
  });
});
