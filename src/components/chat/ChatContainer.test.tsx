import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';

const h = vi.hoisted(() => ({ messages: vi.fn(), reply: vi.fn(), save: vi.fn() }));
const conversation = (id: string) => ({ id, title: id, car_profile_id: `car-${id}`, updated_at: '2026-10-28T00:00:00Z' });
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCar: { id: 'car-current', name: 'Current car' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/ai-client', () => ({ chatViaEdge: h.reply, AiError: class extends Error {} }));
vi.mock('@/lib/chat/db', () => ({
  getConversations: async () => [conversation('A'), conversation('B')],
  getMessages: h.messages, saveMessage: h.save, updateConversationTitle: async () => {},
  createConversation: async () => conversation('New'), deleteConversation: async () => {},
  buildChatContext: async (id: string) => ({ vehicle: { name: id }, sessionCount: 0 }),
}));
import { ChatContainer } from './ChatContainer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const message = (text: string) => ({ id: text, role: 'assistant', parts: [{ type: 'text', text }], createdAt: '' });
async function openConversation(id: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Show past conversations' }));
  const history = await screen.findByRole('region', { name: 'Past conversations' });
  fireEvent.click(await within(history).findByRole('button', { name: new RegExp(`^${id}`) }));
}
function sendQuestion() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'My question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  h.messages.mockImplementation(async (id: string) => [message(`History ${id}`)]);
  h.save.mockResolvedValue({});
  h.reply.mockResolvedValue('Answer');
});
afterEach(cleanup);

it('saves a delayed answer in its original conversation without showing it in another one', async () => {
  const reply = deferred<string>();
  h.reply.mockReturnValue(reply.promise);
  render(<ChatContainer isOpen onClose={() => {}} />);
  await openConversation('A');
  await screen.findByText('History A');
  sendQuestion();
  await waitFor(() => expect(h.reply).toHaveBeenCalled());
  expect(h.reply.mock.calls[0][3]).toBe('car-A');
  await openConversation('B');
  await screen.findByText('History B');
  await act(async () => { reply.resolve('Answer for A'); });
  await waitFor(() => expect(h.save).toHaveBeenCalledWith('A', 'assistant', [{ type: 'text', text: 'Answer for A' }]));
  expect(screen.queryByText('Answer for A')).not.toBeInTheDocument();
  expect(screen.getByText('History B')).toBeInTheDocument();
});

it('ignores history that arrives after a different conversation is selected', async () => {
  const slow = deferred<ReturnType<typeof message>[]>();
  h.messages.mockImplementation((id: string) => id === 'A' ? slow.promise : Promise.resolve([message('History B')]));
  render(<ChatContainer isOpen onClose={() => {}} />);
  await openConversation('A');
  await waitFor(() => expect(h.messages).toHaveBeenCalledWith('A'));
  await openConversation('B');
  await screen.findByText('History B');
  await act(async () => { slow.resolve([message('Late history A')]); });
  expect(screen.queryByText('Late history A')).not.toBeInTheDocument();
  expect(screen.getByText('History B')).toBeInTheDocument();
});

it('opens history inside the same dialog and preserves the draft when returning to chat', async () => {
  render(<ChatContainer isOpen onClose={() => {}} />);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'My draft question' } });
  expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute('src', '/logo.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Show past conversations' }));
  expect(await screen.findByRole('region', { name: 'Past conversations' })).toBeVisible();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('My draft question');
});

it('starts a blank conversation from a labelled action in history and uses the app logo for replies', async () => {
  render(<ChatContainer isOpen onClose={() => {}} />);
  await openConversation('A');
  await screen.findByText('History A');
  expect(screen.getByRole('img', { name: 'Xpeed' })).toHaveAttribute('src', '/logo.svg');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Old draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show past conversations' }));
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(screen.queryByText('History A')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Past conversations' })).not.toBeInTheDocument();
  sendQuestion();
  await waitFor(() => expect(h.save).toHaveBeenCalledWith('New', 'user', [{ type: 'text', text: 'My question' }]));
  await screen.findByText('Answer');
});
