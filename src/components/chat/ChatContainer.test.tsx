import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('./ChatSidebar', () => ({ ChatSidebar: (props: { onSelectConversation: (c: unknown) => void }) => <div>{['A', 'B'].map(id => <button key={id} onClick={() => props.onSelectConversation(conversation(id))}>Open {id}</button>)}</div> }));
vi.mock('./ChatInput', () => ({ ChatInput: (props: { onSend: (text: string) => void }) => <button onClick={() => props.onSend('My question')}>Send question</button> }));
vi.mock('./MessageList', () => ({ MessageList: (props: { messages: { id: string; content: string }[] }) => <div>{props.messages.map(m => <p key={m.id}>{m.content}</p>)}</div> }));
import { ChatContainer } from './ChatContainer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const message = (text: string) => ({ id: text, role: 'assistant', parts: [{ type: 'text', text }], createdAt: '' });
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  h.messages.mockImplementation(async (id: string) => [message(`History ${id}`)]);
  h.save.mockResolvedValue({});
});
afterEach(cleanup);

it('saves a delayed answer in its original conversation without showing it in another one', async () => {
  const reply = deferred<string>();
  h.reply.mockReturnValue(reply.promise);
  render(<ChatContainer isOpen onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open A' }));
  await screen.findByText('History A');
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
  await waitFor(() => expect(h.reply).toHaveBeenCalled());
  expect(h.reply.mock.calls[0][3]).toBe('car-A');
  fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Open A' }));
  await waitFor(() => expect(h.messages).toHaveBeenCalledWith('A'));
  fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
  await screen.findByText('History B');
  await act(async () => { slow.resolve([message('Late history A')]); });
  expect(screen.queryByText('Late history A')).not.toBeInTheDocument();
  expect(screen.getByText('History B')).toBeInTheDocument();
});
