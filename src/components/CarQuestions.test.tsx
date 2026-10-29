import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { CarQuestions } from './CarQuestions';

beforeAll(async () => { await i18n.changeLanguage('en'); });

describe('adding a car', () => {
  it('asks one thing per screen, colour and kind of car included, with the kind guessed from the model', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<CarQuestions onSubmit={onSubmit} onExit={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Toyota' }));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'Hilux' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2019' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByText('What color is it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));

    // Hilux → pickup is already chosen; one tap confirms.
    expect(screen.getByText('What kind of car is it?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /pickup/i })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /pickup/i }));

    fireEvent.click(screen.getByRole('button', { name: /diesel/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      make: 'Toyota', model: 'Hilux', year: 2019, color: 'red', body_type: 'pickup', engine_type: 'diesel',
    }));
  });
});
