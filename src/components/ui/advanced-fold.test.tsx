// The second level of a screen (owner rule, 2026-11-21: XPD-D-SIMPLE-FIRST): closed until asked for, one remembered choice for every screen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PREFERENCES_KEY } from '@/lib/preferences';
import { AdvancedFold } from './advanced-fold';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

const fold = () => render(<AdvancedFold title="Advanced: sectors" hint="The detail." testId="fold"><p data-testid="inside">S1</p></AdvancedFold>);
/** What a click on the summary does in a browser (jsdom does not toggle a `<details>` by itself). */
const toggle = (open: boolean) => { const el = screen.getByTestId('fold') as HTMLDetailsElement; el.open = open; fireEvent(el, new Event('toggle')); };

describe('the advanced fold', () => {
  it('starts closed, with its title on show and what is inside kept in the page', () => {
    fold();
    expect(screen.getByTestId('fold')).not.toHaveAttribute('open');
    expect(screen.getByText('Advanced: sectors')).toBeInTheDocument();
    expect(screen.getByTestId('inside')).toBeInTheDocument();
    expect(screen.getByTestId('inside')).not.toBeVisible();
  });

  it('remembers that the person opened it, for every fold of the site, and that they closed it again', () => {
    fold();
    toggle(true);
    cleanup();
    fold();
    expect(screen.getByTestId('fold')).toHaveAttribute('open');
    toggle(false);
    cleanup();
    fold();
    expect(screen.getByTestId('fold')).not.toHaveAttribute('open');
  });

  it('starts open for someone who turned "Advanced tools" on in Settings, until they close it themselves', () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ advancedTools: true }));
    fold();
    expect(screen.getByTestId('fold')).toHaveAttribute('open');
    toggle(false);
    cleanup();
    fold();
    expect(screen.getByTestId('fold')).not.toHaveAttribute('open');
  });
});
