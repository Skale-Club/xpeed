import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Badge } from './badge';
import { StatusBadge } from './status-badge';

afterEach(cleanup);

describe('Badge variants', () => {
  it('uses the soft style of each tone', () => {
    render(<>
      <Badge variant="success">s</Badge><Badge variant="warn">w</Badge><Badge variant="info">i</Badge><Badge variant="critical">c</Badge>
      <Badge variant="brand2">b2</Badge><Badge variant="muted">m</Badge>
    </>);
    expect(screen.getByText('s')).toHaveClass('border-success-line', 'bg-success-soft', 'text-success');
    expect(screen.getByText('w')).toHaveClass('border-warn-line', 'bg-warn-soft', 'text-warn');
    expect(screen.getByText('i')).toHaveClass('border-info-line', 'bg-info-soft', 'text-info');
    expect(screen.getByText('c')).toHaveClass('border-critical-line', 'bg-critical-soft', 'text-critical');
    expect(screen.getByText('b2')).toHaveClass('text-brand-2');
    expect(screen.getByText('m')).toHaveClass('bg-muted', 'text-muted-foreground');
  });
});

describe('StatusBadge', () => {
  it('maps the tone to a badge variant and shows a dot', () => {
    render(<StatusBadge tone="success">Online</StatusBadge>);
    const badge = screen.getByText('Online');
    expect(badge).toHaveClass('text-success', 'bg-success-soft');
    expect(screen.getByTestId('status-dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses the muted look for neutral and can hide the dot', () => {
    render(<StatusBadge tone="neutral" dot={false}>Idle</StatusBadge>);
    expect(screen.getByText('Idle')).toHaveClass('text-muted-foreground');
    expect(screen.queryByTestId('status-dot')).toBeNull();
  });
});
