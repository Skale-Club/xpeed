import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { List, Map as MapIcon } from 'lucide-react';
import i18n from '@/lib/i18n';
import { SegmentedControl } from './segmented-control';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

type View = 'list' | 'map' | 'grid';
const options: Array<{ value: View; label: string; icon?: typeof List }> = [
  { value: 'list', label: 'List', icon: List },
  { value: 'map', label: 'Map', icon: MapIcon },
  { value: 'grid', label: 'Grid' },
];

function Harness({ onChange }: { onChange?: (v: View) => void }) {
  const [value, setValue] = useState<View>('list');
  return <SegmentedControl options={options} value={value} aria-label="View" testId="seg" onChange={(v) => { setValue(v); onChange?.(v); }} />;
}

describe('SegmentedControl', () => {
  it('is a radiogroup whose radios follow the value', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: 'Map' }));
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'false');
  });

  it('has one tab stop, the selected radio', () => {
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrow keys (wrapping) and jumps with Home and End', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'List' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('map');
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Map' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('grid');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grid' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('list');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'List' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('grid');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grid' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('list');
  });

  it('is h-10 by default, h-8 at size sm, full width on request, and marks busy', () => {
    const { rerender } = render(<SegmentedControl options={options} value="list" onChange={() => {}} aria-label="View" testId="seg" />);
    expect(screen.getByTestId('seg')).toHaveClass('h-10');
    expect(screen.getByTestId('seg')).not.toHaveAttribute('aria-busy');
    rerender(<SegmentedControl options={options} value="list" onChange={() => {}} aria-label="View" testId="seg" size="sm" busy fullWidth />);
    expect(screen.getByTestId('seg')).toHaveClass('h-8', 'w-full');
    expect(screen.getByTestId('seg')).toHaveAttribute('aria-busy', 'true');
  });
});
