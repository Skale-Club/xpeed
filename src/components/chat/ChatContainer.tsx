import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ChatSidebar } from './ChatSidebar';
import { Button } from '@/components/ui/button';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Menu, X, Sparkles, Plus } from 'lucide-react';
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
    buildChatContext,
} from '@/lib/chat/db';
import type { ChatConversation, ChatMessage, ChatContext as ChatContextType } from '@/lib/chat/types';
import { createTextMessage, getMessageText } from '@/lib/chat/types';

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
    const [contextData, setContextData] = useState<ChatContextType | null>(null);
    const [loading, setLoading] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);

    const { selectedCar } = useCarsContext();
    const { toast } = useToast();
    const scrollRef = useRef<HTMLDivElement>(null);

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

    // Build context when car changes
    useEffect(() => {
        async function loadContext() {
            const context = await buildChatContext(selectedCar?.id);
            setContextData(context);
        }
        if (isOpen) {
            loadContext();
        }
    }, [isOpen, selectedCar]);

    // Load messages when conversation changes
    useEffect(() => {
        async function loadConversationMessages() {
            if (!currentConversation) {
                setMessages([]);
                return;
            }
            try {
                const msgs = await getMessages(currentConversation.id);
                setMessages(msgs.map(m => ({
                    id: m.id,
                    role: m.role,
                    content: getMessageText(m),
                })));
            } catch (error) {
                console.error('Failed to load messages:', error);
                setMessages([]);
            }
        }
        loadConversationMessages();
    }, [currentConversation]);

    // Send handler: prefer the server-side Edge Function (admin Gemini key);
    // fall back to direct client-side Gemini call if the user has their own
    // key configured. Either way the user gets an answer.
    const handleSendMessage = useCallback(async (text: string) => {
        // We accept the message even without a per-user apiKey because the
        // Edge Function might be configured with an admin key.
        if (!text.trim()) return;

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
                setCurrentConversation(newConv);
                setConversations(prev => [newConv, ...prev]);
            }

            // Save user message
            await saveMessage(conversationId, 'user', [{ type: 'text', text }]);

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
                (contextData ?? {}) as unknown as Record<string, unknown>,
            );

            // Save assistant message
            const assistantMessageId = crypto.randomUUID();
            await saveMessage(conversationId, 'assistant', [{ type: 'text', text: responseText }]);

            setMessages(prev => [...prev, {
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
            // Remove the user message on error
            setMessages(prev => prev.filter(m => m.id !== userMessageId));
        } finally {
            setLoading(false);
        }
    }, [currentConversation, selectedCar, contextData, messages, toast, t]);

    const handleNewConversation = async () => {
        setCurrentConversation(null);
        setMessages([]);
        setSidebarOpen(false);
    };

    const handleSelectConversation = (conv: ChatConversation) => {
        setCurrentConversation(conv);
        setSidebarOpen(false);
    };

    const handleDeleteConversation = async (id: string) => {
        try {
            await deleteConversation(id);
            setConversations(prev => prev.filter(c => c.id !== id));
            if (currentConversation?.id === id) {
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
    }, [messages]);

    return (
        // A real dialog: Escape closes it, focus stays inside and goes back to the
        // button that opened it. A full-screen sheet on phones, a panel on the right from sm up.
        <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />

                <DialogPrimitive.Content
                    aria-describedby={undefined}
                    className="fixed inset-0 z-50 flex flex-col border bg-card text-card-foreground shadow-2xl animate-in slide-in-from-right duration-300 focus:outline-none sm:inset-y-4 sm:left-auto sm:right-4 sm:w-full sm:max-w-4xl sm:rounded-lg"
                >
                <CardHeader className="flex flex-row items-center justify-between p-4 border-b">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            className="md:hidden"
                            aria-label={t('assistant.showHistory', 'Show past conversations')}
                            aria-expanded={sidebarOpen}
                        >
                            <Menu className="h-5 w-5" />
                        </Button>
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                <Sparkles className="w-4 h-4 text-primary" />
                            </div>
                            <div>
                                <DialogPrimitive.Title asChild>
                                    <CardTitle className="text-lg">Xpeed</CardTitle>
                                </DialogPrimitive.Title>
                                <p className="text-xs text-muted-foreground">
                                    {selectedCar ? selectedCar.name : t('assistant.noCarSelected', 'No car selected')}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={handleNewConversation}>
                            <Plus className="h-4 w-4 mr-1" />
                            {t('assistant.newChat', 'New chat')}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('assistant.close', 'Close')}>
                            <X className="h-5 w-5" />
                        </Button>
                    </div>
                </CardHeader>

                <CardContent className="flex-1 flex overflow-hidden p-0">
                    {/* Sidebar */}
                    <ChatSidebar
                        isOpen={sidebarOpen}
                        conversations={conversations}
                        currentConversationId={currentConversation?.id}
                        onSelectConversation={handleSelectConversation}
                        onDeleteConversation={(id) => setPendingDelete(conversations.find((c) => c.id === id) ?? null)}
                        onNewConversation={handleNewConversation}
                        onClose={() => setSidebarOpen(false)}
                    />

                    {/* Main Chat Area */}
                    <div className="flex-1 flex flex-col">
                        {/* Messages */}
                        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
                            {messages.length === 0 && !loading ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <Sparkles className="w-12 h-12 text-primary mb-4" />
                                    <h3 className="text-lg font-semibold mb-2">
                                        {contextData?.vehicle
                                            ? t('assistant.askAboutCar', 'Ask about your {{name}}', { name: contextData.vehicle.name })
                                            : t('assistant.chooseCar', 'Choose a car to get started')}
                                    </h3>
                                    <p className="text-muted-foreground max-w-md">
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
                    </div>
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
