import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

afterEach(cleanup);

function Sample({ variant }: { variant?: 'pill' | 'underline' }) {
  return (
    <Tabs defaultValue="a">
      <TabsList variant={variant} aria-label="Sections" data-testid="list">
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b">Bravo</TabsTrigger>
      </TabsList>
      <TabsContent value="a">First</TabsContent>
      <TabsContent value="b">Second</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('keeps today\'s pill look by default', () => {
    render(<Sample />);
    expect(screen.getByTestId('list')).toHaveClass('inline-flex', 'h-10', 'rounded-md', 'bg-muted', 'p-1');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveClass('rounded-sm', 'px-3', 'py-1.5', 'data-[state=active]:bg-background');
    expect(screen.getByRole('tab', { name: 'Alpha' })).not.toHaveClass('border-b-2');
  });

  it('draws an underline list and triggers with the underline variant', () => {
    render(<Sample variant="underline" />);
    expect(screen.getByTestId('list')).toHaveClass('border-b', 'border-border');
    expect(screen.getByTestId('list')).not.toHaveClass('bg-muted');
    const tab = screen.getByRole('tab', { name: 'Alpha' });
    expect(tab).toHaveClass('border-b-2', 'data-[state=active]:border-primary');
    expect(tab).not.toHaveClass('rounded-sm');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('First')).toBeInTheDocument();
  });
});
