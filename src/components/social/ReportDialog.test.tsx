import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { fakeSocialState, driver } from '@/test/social-fake-server';
import { ReportButton, ReportDialog } from './ReportDialog';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const LAP = '10000000-0000-4000-8000-000000000007';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const dialogOf = () => screen.getByTestId('report-dialog');

describe('the report dialog', () => {
  it('lists the five reasons, and Send stays off until one is chosen', async () => {
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }]} />);
    const dialog = await screen.findByTestId('report-dialog');
    for (const reason of ['cheating', 'offensive_name', 'impersonation', 'spam', 'other']) expect(within(dialog).getByTestId(`report-reason-${reason}`)).toBeInTheDocument();
    expect(within(dialog).getByTestId('report-send')).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId('report-reason-cheating'));
    expect(within(dialog).getByTestId('report-send')).toBeEnabled();
  });

  it('sends the lap, the reason and the details, and says thank you', async () => {
    const { state } = renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }]} />);
    await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialogOf()).getByTestId('report-reason-cheating'));
    fireEvent.change(within(dialogOf()).getByTestId('report-details'), { target: { value: '  The lap is 4 seconds under the record  ' } });
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    expect(await screen.findByTestId('report-sent')).toHaveTextContent('Thank you');
    const post = callsTo(state, 'POST', '/reports')[0];
    expect(post.body).toEqual({ kind: 'lap', lapId: LAP, reason: 'cheating', details: 'The lap is 4 seconds under the record' });
    expect(post.authorization).toBe('Bearer token');
  });

  it('leaves the details out when there are none', async () => {
    const { state } = renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'profile', handle: 'rival_one' }]} />, { state: fakeSocialState({ drivers: [driver({ handle: 'rival_one' })] }) });
    await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialogOf()).getByTestId('report-reason-spam'));
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    await screen.findByTestId('report-sent');
    expect(callsTo(state, 'POST', '/reports')[0].body).toEqual({ kind: 'profile', handle: 'rival_one', reason: 'spam' });
  });

  it('limits the details to 300 characters and counts them', async () => {
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }]} />);
    await screen.findByTestId('report-dialog');
    const field = within(dialogOf()).getByTestId('report-details');
    expect(field).toHaveAttribute('maxlength', '300');
    fireEvent.change(field, { target: { value: 'a'.repeat(120) } });
    expect(within(dialogOf()).getByTestId('report-count')).toHaveTextContent('120 / 300');
  });

  it('says "already reported" when that report is still open, instead of a failure', async () => {
    const state = fakeSocialState();
    state.reported.add(`lap:${LAP}`);
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }]} />, { state });
    await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialogOf()).getByTestId('report-reason-other'));
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    expect(await screen.findByTestId('report-already')).toHaveTextContent('You already reported this');
    expect(screen.queryByTestId('report-error')).not.toBeInTheDocument();
  });

  it('lets the person choose between the lap and the driver when both are offered', async () => {
    const state = fakeSocialState({ drivers: [driver({ handle: 'rival_one' })] });
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }, { kind: 'profile', handle: 'rival_one' }]} />, { state });
    await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialogOf()).getByLabelText('The driver @rival_one'));
    fireEvent.click(within(dialogOf()).getByTestId('report-reason-impersonation'));
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    await screen.findByTestId('report-sent');
    expect(callsTo(state, 'POST', '/reports')[0].body).toEqual({ kind: 'profile', handle: 'rival_one', reason: 'impersonation' });
  });

  it('says in words when the target cannot be reported, and when the server is down', async () => {
    const state = fakeSocialState();
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'profile', handle: 'ghost' }]} />, { state });
    await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialogOf()).getByTestId('report-reason-spam'));
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    expect(await screen.findByTestId('report-error')).toHaveTextContent('This cannot be reported');
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    fireEvent.click(within(dialogOf()).getByTestId('report-send'));
    await waitFor(() => expect(screen.getByTestId('report-error')).toHaveTextContent('The server is not answering'));
  });

  it('opens from the Report button, starts empty each time and closes with Cancel', async () => {
    renderSocial(<ReportButton targets={[{ kind: 'lap', lapId: LAP }]} />);
    fireEvent.click(screen.getByTestId('report-button'));
    fireEvent.click(within(await screen.findByTestId('report-dialog')).getByTestId('report-reason-cheating'));
    fireEvent.click(within(dialogOf()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('report-dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('report-button'));
    expect(within(await screen.findByTestId('report-dialog')).getByTestId('report-reason-cheating')).not.toBeChecked();
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    renderSocial(<ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'lap', lapId: LAP }]} />);
    expect(await screen.findByTestId('report-dialog')).toHaveTextContent('Trapaça ou tempo impossível');
  });
});
