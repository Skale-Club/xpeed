import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Car } from 'lucide-react';
import i18n from '@/lib/i18n';
import { EmptyState, ErrorState, LoadingState } from './states';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('EmptyState', () => {
  it('shows the title, the description and the action', () => {
    render(<EmptyState icon={Car} title="No cars yet" description="Add your car." action={<button>Add car</button>} testId="empty" />);
    expect(screen.getByRole('heading', { name: 'No cars yet' })).toBeInTheDocument();
    expect(screen.getByText('Add your car.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add car' })).toBeInTheDocument();
    expect(screen.getByTestId('empty').querySelector('.bg-surface-raised.rounded-full')).not.toBeNull();
  });

  it('is tighter when compact', () => {
    const { rerender } = render(<EmptyState title="x" testId="empty" />);
    expect(screen.getByTestId('empty')).toHaveClass('py-12');
    rerender(<EmptyState title="x" compact testId="empty" />);
    expect(screen.getByTestId('empty')).toHaveClass('py-6');
  });
});

describe('ErrorState', () => {
  it('is an alert with default words and a retry', () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows its own words and no retry without onRetry', () => {
    render(<ErrorState title="Cars failed" description="Check your connection." />);
    expect(screen.getByText('Cars failed')).toBeInTheDocument();
    expect(screen.getByText('Check your connection.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('disables the retry while retrying', () => {
    render(<ErrorState onRetry={() => {}} retrying />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });
});

describe('LoadingState', () => {
  it('is a spinner with a screen-reader label by default', () => {
    render(<LoadingState />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('uses a custom label', () => {
    render(<LoadingState label="Loading cars" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading cars');
  });

  it('draws placeholder rows and cards', () => {
    const { rerender } = render(<LoadingState variant="list" testId="ld" />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(screen.getByTestId('ld').children).toHaveLength(4);
    rerender(<LoadingState variant="list" rows={2} testId="ld" />);
    expect(screen.getByTestId('ld').children).toHaveLength(2);
    rerender(<LoadingState variant="cards" testId="ld" />);
    expect(screen.getByTestId('ld').children).toHaveLength(6);
    expect(screen.getByTestId('ld')).toHaveClass('grid');
  });
});
