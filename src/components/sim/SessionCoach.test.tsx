import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { isCoachEnabled, setCoachEnabled } from '@/lib/sim/coach-preferences';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';
import type { ChatScope } from '@/lib/chat/types';
import { SessionCoach } from './SessionCoach';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  history: vi.fn(),
  save: vi.fn(),
  reply: vi.fn(),
  toast: vi.fn(),
  training: vi.fn(),
  setups: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast, useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/lib/ai-client', () => ({ chatViaEdge: mocks.reply, AiError: class extends Error {} }));
vi.mock('@/lib/chat/db', () => ({
  getConversations: mocks.list,
  createConversation: mocks.create,
  getMessages: mocks.history,
  saveMessage: mocks.save,
  updateConversationTitle: async () => {},
  deleteConversation: async () => {},
}));
vi.mock('./TrainingGoals', () => ({
  default: ({ userId, sessionId }: { userId: string; sessionId: string }) => {
    mocks.training(userId, sessionId);
    return <div>Training panel for {userId} and {sessionId}</div>;
  },
}));
vi.mock('./SessionSetups', () => ({
  default: ({ userId, sessionId }: { userId: string; sessionId: string }) => {
    mocks.setups(userId, sessionId);
    return <div>Setups for {userId} and {sessionId}</div>;
  },
}));

const monza = {
  id: 'monza-session',
  game: 'lmu',
  car: { id: '499p', name: 'Ferrari 499P' },
  track: { id: 'monza', name: 'Monza' },
  kind: 'qualifying' as const,
};
const spa = { ...monza, id: 'spa-session', track: { id: 'spa', name: 'Spa' } };
const conversation = (sessionId: string) => ({
  id: `conversation-${sessionId}`,
  title: `Chat about ${sessionId}`,
  mode: 'virtual',
  sim_session_id: sessionId,
  car_profile_id: null,
  updated_at: '2026-11-18T00:00:00Z',
});
const recorded = (text: string) => ({ id: text, role: 'assistant', parts: [{ type: 'text', text }], createdAt: '' });

const button = (name: string) => screen.getByRole('button', { name });
const mount = () => render(<SessionCoach userId="ana" session={monza} />, { wrapper: MemoryRouter });

async function openCoach() {
  fireEvent.click(button('Open coach'));
  return screen.findByRole('dialog', { name: 'Session coach' });
}

async function openHistory(sessionId: string) {
  fireEvent.click(button('Show past conversations'));
  const history = await screen.findByRole('region', { name: 'Past conversations' });
  const pastChat = await within(history).findByRole('button', { name: new RegExp(`^Chat about ${sessionId}`) });
  fireEvent.click(pastChat);
  await screen.findByText(`History from conversation-${sessionId}`);
}

beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  leaveDemo();
  await i18n.changeLanguage('en');
  mocks.list.mockImplementation(async ({ sessionId }: ChatScope) => [conversation(sessionId)]);
  mocks.create.mockImplementation(async (_title: string, _car: undefined, { sessionId }: ChatScope) => ({
    ...conversation(sessionId),
    id: 'new-conversation',
  }));
  mocks.history.mockImplementation(async (id: string) => [recorded(`History from ${id}`)]);
  mocks.save.mockResolvedValue({ id: 'saved-message' });
  mocks.reply.mockResolvedValue('Your valid laps were consistent.');
});

afterEach(() => {
  cleanup();
  leaveDemo();
  localStorage.clear();
});

it('requires opt-in and opening, and fills a draft without sending the suggested question', async () => {
  const view = mount();
  expect(screen.getByRole('region', { name: 'Session coach' })).toHaveTextContent('lap and sector times');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.reply).not.toHaveBeenCalled();

  fireEvent.click(button('Enable coach'));
  expect(isCoachEnabled('ana')).toBe(true);
  expect(mocks.list).not.toHaveBeenCalled();
  const dialog = await openCoach();
  const label = 'Monza · Ferrari 499P · Le Mans Ultimate · Qualifying';
  const scope = { mode: 'virtual', sessionId: monza.id, label };
  expect(within(dialog).getByRole('link', { name: label })).toHaveAttribute('href', `/virtual/sessions/${monza.id}`);
  expect(dialog.querySelector('img')).toHaveAttribute('src', '/logo.svg');
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(scope));

  const drivingQuestion = 'Where did I lose time in the analysed lap?';
  fireEvent.click(button(drivingQuestion));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(drivingQuestion);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.reply).not.toHaveBeenCalled();

  const question = 'How consistent were my valid laps?';
  fireEvent.click(button(question));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(question);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.reply).not.toHaveBeenCalled();
  fireEvent.click(button('Send'));
  expect(await screen.findByText('Your valid laps were consistent.')).toBeInTheDocument();
  expect(mocks.create).toHaveBeenCalledWith(question, undefined, scope);
  expect(mocks.save).toHaveBeenCalledWith('new-conversation', 'user', [{ type: 'text', text: question }]);
  expect(mocks.reply).toHaveBeenCalledWith([], question, {}, undefined, {
    mode: 'virtual',
    sessionId: monza.id,
    conversationId: 'new-conversation',
    messageId: 'saved-message',
  });

  fireEvent.click(button('Close'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(button('Disable coach'));
  expect(isCoachEnabled('ana')).toBe(false);
  view.unmount();
  mount();
  expect(button('Enable coach')).toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it('loads training goals only when the opted-in driver opens them and resets on session change or disable', async () => {
  const view = mount();
  expect(screen.queryByRole('button', { name: 'Training goals' })).not.toBeInTheDocument();
  fireEvent.click(button('Enable coach'));
  expect(button('Training goals')).toHaveAttribute('aria-expanded', 'false');
  expect(mocks.training).not.toHaveBeenCalled();

  fireEvent.click(button('Training goals'));
  expect(await screen.findByText('Training panel for ana and monza-session')).toBeInTheDocument();
  expect(mocks.training).toHaveBeenLastCalledWith('ana', monza.id);
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();
  fireEvent.click(button('Training goals'));
  expect(screen.queryByText(/Training panel for/)).not.toBeInTheDocument();

  view.rerender(<SessionCoach userId="ana" session={spa} />);
  expect(button('Training goals')).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button('Training goals'));
  expect(await screen.findByText('Training panel for ana and spa-session')).toBeInTheDocument();
  fireEvent.click(button('Disable coach'));
  expect(screen.queryByRole('button', { name: 'Training goals' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Training panel for/)).not.toBeInTheDocument();
});

it('loads the private setup library only when explicitly opened after opt-in', async () => {
  const view = mount();
  expect(screen.queryByRole('button', { name: 'Car setups' })).not.toBeInTheDocument();
  fireEvent.click(button('Enable coach'));
  expect(button('Car setups')).toHaveAttribute('aria-expanded', 'false');
  expect(mocks.setups).not.toHaveBeenCalled();

  fireEvent.click(button('Car setups'));
  expect(await screen.findByText('Setups for ana and monza-session')).toBeInTheDocument();
  expect(mocks.setups).toHaveBeenCalledWith('ana', monza.id);
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();

  view.rerender(<SessionCoach userId="ana" session={spa} />);
  expect(screen.queryByText(/Setups for/)).not.toBeInTheDocument();
  expect(button('Car setups')).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button('Car setups'));
  expect(await screen.findByText('Setups for ana and spa-session')).toBeInTheDocument();
  fireEvent.click(button('Disable coach'));
  expect(screen.queryByRole('button', { name: 'Car setups' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Setups for/)).not.toBeInTheDocument();
});

it('reloads history for the new session and drops a reply arriving after the previous session closes', async () => {
  setCoachEnabled('ana', true);
  const view = mount();
  await openCoach();
  await openHistory(monza.id);
  let finishReply!: (value: string) => void;
  mocks.reply.mockReturnValueOnce(new Promise<string>((resolve) => { finishReply = resolve; }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'What stood out?' } });
  fireEvent.click(button('Send'));
  await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith([], 'What stood out?', {}, undefined, {
    mode: 'virtual',
    sessionId: monza.id,
    conversationId: `conversation-${monza.id}`,
    messageId: 'saved-message',
  }));

  view.rerender(<SessionCoach userId="ana" session={spa} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await openCoach();
  await openHistory(spa.id);
  await act(async () => finishReply('Late reply for Monza'));
  expect(screen.queryByText('Late reply for Monza')).not.toBeInTheDocument();
  expect(screen.queryByText(`History from conversation-${monza.id}`)).not.toBeInTheDocument();
  expect(mocks.list.mock.calls.map(([scope]) => scope.sessionId)).toEqual([monza.id, spa.id]);
  expect(mocks.history.mock.calls).toEqual([[`conversation-${monza.id}`], [`conversation-${spa.id}`]]);
  expect(mocks.save.mock.calls.map(([, role]) => role)).toEqual(['user']);
});

it('uses each account’s preference and closes the coach when the account changes', async () => {
  setCoachEnabled('ana', true);
  const view = mount();
  await openCoach();
  await openHistory(monza.id);
  view.rerender(<SessionCoach userId="bia" session={monza} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button('Enable coach')).toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  view.rerender(<SessionCoach userId="ana" session={monza} />);
  expect(button('Open coach')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('hides on example mode and stops a pending create from starting a question', async () => {
  setCoachEnabled('ana', true);
  mount();
  await openCoach();
  let finishCreate!: (value: ReturnType<typeof conversation>) => void;
  mocks.create.mockReturnValueOnce(new Promise((resolve) => { finishCreate = resolve; }));
  fireEvent.click(button('How consistent were my valid laps?'));
  fireEvent.click(button('Send'));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));

  await act(async () => enterDemo());
  expect(screen.queryByRole('region', { name: 'Session coach' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => finishCreate(conversation(monza.id)));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(isCoachEnabled('ana')).toBe(true);
});
