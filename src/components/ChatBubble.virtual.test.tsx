import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';

const h = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), save: vi.fn(), reply: vi.fn(), user: { id: 'driver' } as { id: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => { throw new Error('The Virtual assistant must not read the Real cars'); } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/ai-client', () => ({ chatViaEdge: h.reply, AiError: class extends Error {} }));
vi.mock('@/lib/chat/db', () => ({
  getConversations: h.list, createConversation: h.create, saveMessage: h.save,
  getMessages: async () => [], updateConversationTitle: async () => {}, deleteConversation: async () => {},
}));
import { ChatBubble } from './ChatBubble';

const thread = { id: 'thread-1', title: 'Q', user_id: 'driver', car_profile_id: null, mode: 'virtual', sim_session_id: null, created_at: '', updated_at: '' };

beforeEach(async () => {
  vi.clearAllMocks();
  h.user = { id: 'driver' };
  leaveDemo();
  await i18n.changeLanguage('en');
  h.list.mockResolvedValue([]);
  h.create.mockResolvedValue(thread);
  h.save.mockResolvedValue({ id: '40000000-0000-4000-8000-000000000001' });
  h.reply.mockResolvedValue('Work on your braking at Monza.');
});
afterEach(() => { cleanup(); leaveDemo(); });

it('opens the racing assistant on Virtual and asks about the whole racing, not one session', async () => {
  render(<ChatBubble mode="virtual" />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask the racing assistant' }));
  expect(await screen.findByRole('dialog', { name: 'Racing assistant' })).toBeInTheDocument();
  await waitFor(() => expect(h.list).toHaveBeenCalledWith({ mode: 'virtual', sessionId: null }));

  fireEvent.click(screen.getByRole('button', { name: 'What should I practise next?' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Work on your braking at Monza.')).toBeInTheDocument();
  expect(h.create).toHaveBeenCalledWith('What should I practise next?', undefined, { mode: 'virtual', sessionId: null });
  const [history, text, , car, virtual] = h.reply.mock.calls[0];
  expect(history).toEqual([]);
  expect(text).toBe('What should I practise next?');
  expect(car).toBeUndefined();
  // No session is sent: the server reads the driver's racing and the saved history itself.
  expect(virtual).toEqual({ mode: 'virtual', conversationId: 'thread-1', messageId: '40000000-0000-4000-8000-000000000001' });
});

it('has no assistant in the Virtual example or when signed out', () => {
  enterDemo();
  const { unmount } = render(<ChatBubble mode="virtual" />);
  expect(screen.queryByRole('button', { name: 'Ask the racing assistant' })).not.toBeInTheDocument();
  unmount();
  leaveDemo();
  h.user = null;
  render(<ChatBubble mode="virtual" />);
  expect(screen.queryByRole('button', { name: 'Ask the racing assistant' })).not.toBeInTheDocument();
});
