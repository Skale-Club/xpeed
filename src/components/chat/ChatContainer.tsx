import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ChatSidebar } from './ChatSidebar';
import { Button } from '@/components/ui/button';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { History, X } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import { AiError, chatViaEdge } from '@/lib/ai-client';
import {
    getConversations,
    createConversation,
    deleteConversation,
    updateConversationTitle,
    getMessages,
    saveMessage,
} from '@/lib/chat/db';
import type { ChatConversation } from '@/lib/chat/types';
import { getMessageText } from '@/lib/chat/types';

interface ChatContainerProps {
    isOpen: boolean;
    onClose: () => void;
}

interface UIMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

export function ChatContainer({ isOpen, onClose }: ChatContainerProps) {
    const { t } = useTranslation();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [conversations, setConversations] = useState<ChatConversation[]>([]);
    const [currentConversation, setCurrentConversation] = useState<ChatConversation | null>(null);
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);

    const { selectedCar, cars = [] } = useCarsContext();
    const { toast } = useToast();
    const scrollRef = useRef<HTMLDivElement>(null);
    const viewVersion = useRef(0);
    const sending = useRef(false);
    const skipLoad = useRef<string | null>(null);
    const chatCarId = currentConversation ? currentConversation.car_profile_id : selectedCar?.id;

    const chatCar = cars.find(car => car.id === chatCarId) ?? (selectedCar?.id === chatCarId ? selectedCar : null);

    // Model is admin-configured server-side (app_settings.admin_openrouter_model);
    // the client does not choose or send a model.

    // Load conversations on mount
    useEffect(() => {
        async function loadConversations() {
            try {
                const convs = await getConversations();
                setConversations(convs);
            } catch (error) {
                console.error('Failed to load conversations:', error);
            }
        }
        if (isOpen) {
            loadConversations();
        }
    }, [isOpen]);

    // The server builds context from the authorized car.

    // Load messages when conversation changes
    useEffect(() => {
        let cancelled = false;
        const version = viewVersion.current;
        if (currentConversation && skipLoad.current === currentConversation.id) {
            skipLoad.current = null;
            return;
        }
        async function loadConversationMessages() {
            if (!currentConversation) {
                setMessages([]);
                return;
            }
            try {
                const msgs = await getMessages(currentConversation.id);
                if (cancelled || version !== viewVersion.current) return;
                setMessages(msgs.map(m => ({
                    id: m.id,
                    role: m.role,
                    content: getMessageText(m),
                })));
            } catch (error) {
                console.error('Failed to load messages:', error);
                if (!cancelled && version === viewVersion.current) setMessages([]);
            }
        }
        loadConversationMessages();
        return () => { cancelled = true; };
    }, [currentConversation]);

    // Replies stay with their originating conversation even when the user
    // opens another conversation while the server is answering.
    const handleSendMessage = useCallback(async (text: string) => {
        // We accept the message even without a per-user apiKey because the
        // Edge Function might be configured with an admin key.
        if (!text.trim() || sending.current) return;
        sending.current = true;
        const version = ++viewVersion.current;
        let userSaved = false;

        setLoading(true);
        const userMessageId = crypto.randomUUID();

        // Add user message immediately
        setMessages(prev => [...prev, {
            id: userMessageId,
            role: 'user',
            content: text,
        }]);
        setInput('');

        try {
            // Create conversation if needed
            let conversationId = currentConversation?.id;
            if (!conversationId) {
                const newConv = await createConversation(
                    text.slice(0, 50) + (text.length > 50 ? '...' : ''),
                    selectedCar?.id
                );
                conversationId = newConv.id;
                if (version === viewVersion.current) {
                    skipLoad.current = newConv.id;
                    setCurrentConversation(newConv);
                }
                setConversations(prev => [newConv, ...prev]);
            }

            // Save user message
            await saveMessage(conversationId, 'user', [{ type: 'text', text }]);
            userSaved = true;

            // Build history (last 10 turns) for both Edge + fallback paths
            const historyMessages = messages.slice(-10).map(m => ({
                role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
                parts: m.content,
            }));

            // Single-provider AI: only the shared admin-configured Edge Function.
            // It throws AiError saying why when there is no answer (handled below).
            const responseText = await chatViaEdge(
                historyMessages,
                text,
                {},
                chatCarId,
            );

            // Save assistant message
            const assistantMessageId = crypto.randomUUID();
            await saveMessage(conversationId, 'assistant', [{ type: 'text', text: responseText }]);

            if (version === viewVersion.current) setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: responseText,
            }]);

            // Update conversation title if this was the first message
            if (messages.length === 0) {
                await updateConversationTitle(conversationId, text.slice(0, 50) + (text.length > 50 ? '...' : ''));
                setConversations(prev => prev.map(c =>
                    c.id === conversationId ? { ...c, title: text.slice(0, 50) } : c
                ));
            }
        } catch (error) {
            console.error('Chat error:', error);
            const kind = error instanceof AiError ? error.kind : 'unavailable';
            toast({
                title: t('assistant.errorTitle', 'Something went wrong'),
                description: kind === 'limit_reached'
                    ? t('assistant.limitReached', "You've used today's questions. The assistant is back tomorrow.")
                    : kind === 'not_configured'
                        ? t('assistant.notConfigured', "The assistant isn't switched on yet. Ask whoever runs your Xpeed to turn it on.")
                        : t('assistant.replyFailed', "The assistant couldn't answer right now. Please try again in a moment."),
                variant: 'destructive',
            });
            // Keep questions already persisted when only the reply failed.
            if (!userSaved && version === viewVersion.current) setMessages(prev => prev.filter(m => m.id !== userMessageId));
        } finally {
            sending.current = false;
            setLoading(false);
        }
    }, [currentConversation, selectedCar, chatCarId, messages, toast, t]);

    const handleNewConversation = () => {
        viewVersion.current++;
        setCurrentConversation(null);
        setMessages([]);
        setInput('');
        setSidebarOpen(false);
    };

    const handleSelectConversation = (conv: ChatConversation) => {
        viewVersion.current++;
        setMessages([]);
        setInput('');
        setCurrentConversation(conv);
        setSidebarOpen(false);
    };

    const handleDeleteConversation = async (id: string) => {
        try {
            await deleteConversation(id);
            setConversations(prev => prev.filter(c => c.id !== id));
            if (currentConversation?.id === id) {
                viewVersion.current++;
                setCurrentConversation(null);
                setMessages([]);
            }
        } catch (error) {
            toast({
                title: t('assistant.errorTitle', 'Something went wrong'),
                description: t('assistant.deleteFailed', "Couldn't delete this conversation. Please try again."),
                variant: 'destructive',
            });
        }
    };

    // Scroll to bottom when messages change
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, sidebarOpen]);

    return (
        // A real dialog: Escape closes it, focus stays inside and goes back to the
        // button that opened it. A full-screen sheet on phones, a panel on the right from sm up.
        <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />

                <DialogPrimitive.Content
                    aria-describedby={undefined}
                    className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-2xl animate-in slide-in-from-right duration-300 focus:outline-none sm:inset-y-4 sm:left-auto sm:right-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl"
                >
                <CardHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 gap-3 border-b p-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <BrandLogo alt="" />
                            <div className="min-w-0">
                                <DialogPrimitive.Title asChild>
                                    <CardTitle className="text-lg">Xpeed</CardTitle>
                                </DialogPrimitive.Title>
                                <p className="truncate text-xs text-muted-foreground">
                                    {chatCar?.name || t('assistant.noCarSelected', 'No car selected')}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            aria-label={sidebarOpen ? t('assistant.backToChat', 'Back to chat') : t('assistant.showHistory', 'Show past conversations')}
                            title={sidebarOpen ? t('assistant.backToChat', 'Back to chat') : t('assistant.showHistory', 'Show past conversations')}
                            aria-expanded={sidebarOpen}
                            aria-controls="chat-history"
                            className={sidebarOpen ? 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary' : undefined}
                        >
                            <History className="h-5 w-5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('assistant.close', 'Close')}>
                            <X className="h-5 w-5" />
                        </Button>
                    </div>
                </CardHeader>

                <CardContent className="flex min-h-0 flex-1 overflow-hidden p-0">
                    {sidebarOpen ? <ChatSidebar
                        conversations={conversations}
                        currentConversationId={currentConversation?.id}
                        onSelectConversation={handleSelectConversation}
                        onDeleteConversation={(id) => setPendingDelete(conversations.find((c) => c.id === id) ?? null)}
                        onNewConversation={handleNewConversation}
                    /> : (

                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        {/* Messages */}
                        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
                            {messages.length === 0 && !loading ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <BrandLogo alt="" className="mb-4 h-12 w-12" />
                                    <h3 className="text-lg font-semibold mb-2">
                                        {chatCar
                                            ? t('assistant.askAboutCar', 'Ask about your {{name}}', { name: chatCar.name })
                                            : t('assistant.chooseCar', 'Choose a car to get started')}
                                    </h3>
                                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                                        {t('assistant.intro', "I can explain what your car's readings mean, tell you what a fault code means in plain words, and suggest when it needs a check-up.")}
                                    </p>
                                </div>
                            ) : (
                                <MessageList
                                    messages={messages}
                                    isLoading={loading}
                                />
                            )}
                        </div>

                        {/* Input */}
                        <ChatInput
                            input={input}
                            setInput={setInput}
                            onSend={handleSendMessage}
                            isLoading={loading}
                            disabled={false}
                        />
                    </div>)}
                </CardContent>

                <ConfirmDialog
                    open={!!pendingDelete}
                    onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
                    title={t('assistant.deleteTitle', 'Delete this conversation?')}
                    description={t('assistant.deleteBody', "\"{{title}}\" and its messages will be removed. This can't be undone.", { title: pendingDelete?.title ?? '' })}
                    confirmLabel={t('assistant.deleteChat', 'Delete conversation')}
                    onConfirm={() => { if (pendingDelete) void handleDeleteConversation(pendingDelete.id); setPendingDelete(null); }}
                />
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
