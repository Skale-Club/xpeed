import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { LoadMore } from './load-more';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('LoadMore', () => {
  it('renders nothing when there is no next page', () => {
    const { container } = render(<LoadMore hasNextPage={false} isFetchingNextPage={false} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for the next page when clicked', () => {
    const onClick = vi.fn();
    render(<LoadMore hasNextPage isFetchingNextPage={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled while the next page is loading', () => {
    render(<LoadMore hasNextPage isFetchingNextPage onClick={() => {}} testId="more" />);
    expect(screen.getByTestId('more')).toBeDisabled();
  });
});
