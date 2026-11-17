import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { chooseOption, selectOptions } from '@/test/select';
import { FilterSelect, SearchField } from './filter-fields';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('FilterSelect', () => {
  const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }];

  it('has an "all" first entry and reports the picked value', () => {
    const onChange = vi.fn();
    render(<FilterSelect label="Track" value="" onChange={onChange} options={options} allLabel="All tracks" />);
    const trigger = screen.getByRole('combobox', { name: 'Track' });
    expect(selectOptions(trigger)).toEqual(['All tracks', 'Alpha', 'Bravo']);
    chooseOption(trigger, 'Bravo');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('is the compact h-8 control', () => {
    render(<FilterSelect label="Track" value="a" onChange={() => {}} options={options} allLabel="All" testId="fs" />);
    expect(screen.getByTestId('fs')).toHaveClass('h-8', 'text-xs');
  });
});

describe('SearchField', () => {
  function Harness({ initial = '' }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return <SearchField label="Search cars" value={value} onChange={setValue} testId="sf" />;
  }

  it('is a labelled search box that reports typing', () => {
    render(<Harness />);
    const box = screen.getByRole('searchbox', { name: 'Search cars' });
    fireEvent.change(box, { target: { value: 'gt3' } });
    expect(box).toHaveValue('gt3');
  });

  it('shows a clear button only when there is text, and clears', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'gt3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });
});
