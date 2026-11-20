import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Timer } from 'lucide-react';
import { Panel, PanelSection } from './panel';

afterEach(cleanup);

describe('Panel', () => {
  it('renders title, description, action and content', () => {
    render(<Panel title="Laps" description="The last ten" action={<button>More</button>} testId="p"><p>Body</p></Panel>);
    expect(screen.getByRole('heading', { level: 3, name: 'Laps' })).toHaveClass('text-sm', 'font-semibold');
    expect(screen.getByText('The last ten')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(screen.getByTestId('p')).toHaveTextContent('Body');
  });

  it('has no header without title, description or action', () => {
    render(<Panel>Just content</Panel>);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('pads the content by default and not when padded is false', () => {
    const { rerender } = render(<Panel testId="p">x</Panel>);
    expect(screen.getByTestId('p').firstElementChild).toHaveClass('p-4');
    rerender(<Panel testId="p" padded={false}>x</Panel>);
    expect(screen.getByTestId('p').firstElementChild).toHaveClass('p-0');
  });
});

describe('PanelSection', () => {
  it('renders a heading over its content', () => {
    render(<PanelSection title="Tyres" description="Front and rear">x</PanelSection>);
    expect(screen.getByRole('heading', { level: 4, name: 'Tyres' })).toBeInTheDocument();
    expect(screen.getByText('Front and rear')).toBeInTheDocument();
  });
});

describe('Panel, Dashboards 2027 feature variant (proposed 2026-11-20)', () => {
  it('has the 16 px corner, 20 px inside, an accent icon and the action beside the title', () => {
    render(<Panel variant="feature" title="Activity" description="Laps per day" icon={Timer} accent="blue" action={<span>legend</span>} testId="p"><p>Chart</p></Panel>);
    const panel = screen.getByTestId('p');
    expect(panel).toHaveAttribute('data-variant', 'feature');
    expect(panel).toHaveClass('rounded-panel');
    expect(panel.firstElementChild).toHaveClass('p-5');
    expect(screen.getByRole('heading', { level: 3, name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('legend')).toBeInTheDocument();
    expect(panel.querySelector('svg')).not.toBeNull();
  });

  it('leaves the default panel as it was', () => {
    render(<Panel title="Laps" testId="d">Body</Panel>);
    expect(screen.getByTestId('d')).not.toHaveAttribute('data-variant');
    expect(screen.getByTestId('d')).not.toHaveClass('rounded-panel');
  });
});
