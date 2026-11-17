import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { chooseOption } from '@/test/select';
import { Pagination } from './pagination';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('Pagination', () => {
  it('is a labelled nav with the page text', () => {
    render(<Pagination page={2} pageCount={5} onPageChange={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 5')).toBeInTheDocument();
  });

  it('asks for the previous and next page', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageCount={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it('disables the ends', () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    rerender(<Pagination page={3} pageCount={3} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('is h-10 on a phone and hides the button text below sm', () => {
    render(<Pagination page={2} pageCount={3} onPageChange={() => {}} />);
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toHaveClass('h-10', 'sm:h-9');
    expect(previous.querySelector('span')).toHaveClass('hidden', 'sm:inline');
  });

  it('shows the range when it knows the total and the page size', () => {
    const { rerender } = render(<Pagination page={2} pageCount={3} total={25} pageSize={10} onPageChange={() => {}} />);
    expect(screen.getByText('11–20 of 25')).toBeInTheDocument();
    rerender(<Pagination page={3} pageCount={3} total={25} pageSize={10} onPageChange={() => {}} />);
    expect(screen.getByText('21–25 of 25')).toBeInTheDocument();
  });

  it('jumps to a page with the drop-down, only when asked and when there is more than one page', () => {
    const onPageChange = vi.fn();
    const { rerender } = render(<Pagination page={1} pageCount={4} showJump onPageChange={onPageChange} />);
    chooseOption(screen.getByRole('combobox', { name: 'Go to page' }), 'Page 3');
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    rerender(<Pagination page={1} pageCount={1} showJump onPageChange={onPageChange} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    rerender(<Pagination page={1} pageCount={4} onPageChange={onPageChange} />);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
