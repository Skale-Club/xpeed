import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { PageHeader } from './page-header';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title as an h2 with the description under it', () => {
    render(<PageHeader title="Overview" description="Your driving at a glance" testId="head" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Your driving at a glance')).toHaveClass('text-sm', 'text-muted-foreground');
    expect(screen.getByTestId('head')).toBeInTheDocument();
  });

  it('shows the icon (hidden from screen readers) and the actions in a wrapping row', () => {
    const { container } = render(<PageHeader icon={Gauge} title="Fuel" actions={<button>Add</button>} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Add' }).parentElement?.parentElement).toHaveClass('flex-wrap');
  });

  it('renders a back link when asked, and none otherwise', () => {
    const { rerender } = render(<MemoryRouter><PageHeader title="Car" back={{ to: '/garage', label: 'Garage' }} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Garage' })).toHaveAttribute('href', '/garage');
    rerender(<MemoryRouter><PageHeader title="Car" /></MemoryRouter>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('PageHeader, Dashboards 2027 lg size (proposed 2026-11-20)', () => {
  it('puts the eyebrow above a 30 px title, the summary under it and the actions beside', () => {
    render(<PageHeader size="lg" eyebrow="Overview · last 7 days" title="Overview" description="6 laps in 3 sessions." actions={<button>7 days</button>} testId="h" />);
    expect(screen.getByTestId('h-eyebrow')).toHaveTextContent('Overview · last 7 days');
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toHaveClass('text-[30px]');
    expect(screen.getByText('6 laps in 3 sessions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
  });

  it('keeps the 20 px title by default', () => {
    render(<PageHeader title="Overview" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toHaveClass('text-xl');
  });
});
