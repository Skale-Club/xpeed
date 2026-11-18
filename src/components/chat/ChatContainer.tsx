import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
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
import type { ChatConversation, ChatScope } from '@/lib/chat/types';
import { getMessageText } from '@/lib/chat/types';
import { isDemoMode } from '@/lib/sim/demo/mode';
import { sessionPath } from '@/lib/sim/routes';

interface ChatContainerProps {
    isOpen: boolean;
    onClose: () => void;
    scope?: ChatScope;
    restoreFocus?: () => void;
}

interface UIMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

export function ChatContainer(props: ChatContainerProps) {
    return props.scope
        ? <ChatDialog key={props.scope.sessionId} {...props} />
        : <RealChatDialog {...props} />;
}

function RealChatDialog(props: ChatContainerProps) {
    const { selectedCar, cars } = useCarsContext();
    return <ChatDialog {...props} selectedCar={selectedCar} cars={cars} />;
}

type ChatCars = Partial<Pick<ReturnType<typeof useCarsContext>, 'selectedCar' | 'cars'>>;

function ChatWelcome({ virtual, carName, selectPrompt }: { virtual: boolean; carName?: string; selectPrompt: (prompt: string) => void }) {
    const { t } = useTranslation();
    if (virtual) {
        return (
            <div className="flex min-h-full flex-col items-center justify-center gap-4 p-2 text-center">
                <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t('modes.coach.intro')}</p>
                <div className="flex flex-wrap justify-center gap-2">
                    {(['sectors', 'consistency', 'driving'] as const).map((question) => {
                        const prompt = t(`modes.coach.questions.${question}`);
                        return (
                            <Button key={question} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal py-2" onClick={() => selectPrompt(prompt)}>
                                {prompt}
                            </Button>
                        );
                    })}
                </div>
            </div>
        );
    }
    return (
        <div className="flex flex-col items-center justify-center h-full text-center">
            <BrandLogo alt="" className="mb-4 h-12 w-12" />
            <h3 className="text-lg font-semibold mb-2">
                {carName
                    ? t('assistant.askAboutCar', 'Ask about your {{name}}', { name: carName })
                    : t('assistant.chooseCar', 'Choose a car to get started')}
            </h3>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                {t('assistant.intro', "I can explain what your car's readings mean, tell you what a fault code means in plain words, and suggest when it needs a check-up.")}
            </p>
        </div>
    );
}

function ChatDialog({ isOpen, onClose, scope, restoreFocus, selectedCar, cars = [] }: ChatContainerProps & ChatCars) {
    const { t } = useTranslation();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [conversations, setConversations] = useState<ChatConversation[]>([]);
    const [currentConversation, setCurrentConversation] = useState<ChatConversation | null>(null);
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [historyLoading,setHistoryLoading]=useState(false);
    const [historyFailed,setHistoryFailed]=useState(false);
    const [historyAttempt,setHistoryAttempt]=useState(0);
    const [listFailed,setListFailed]=useState(false);
    const [listAttempt,setListAttempt]=useState(0);
    const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);

    const { toast } = useToast();
    const scrollRef = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);
    const viewVersion = useRef(0);
    const sending = useRef(false);
    const skipLoad = useRef<string | null>(null);
    const virtual = !!scope;
    const chatCarId = currentConversation ? currentConversation.car_profile_id : selectedCar?.id;

    const chatCar = cars.find(car => car.id === chatCarId) ?? (selectedCar?.id === chatCarId ? selectedCar : null);

    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            viewVersion.current++;
        };
    }, []);

    // Load conversations on mount
    useEffect(() => {
        let active=true;
        async function loadConversations() {
            try {
                const convs = await (scope ? getConversations(scope) : getConversations());
                if(active){setConversations(convs);setListFailed(false);}
            } catch (error) {
                console.error('Failed to load conversations:', error);
                if(active)setListFailed(true);
            }
        }
        if (isOpen && (!scope || !isDemoMode())) {
            loadConversations();
        }
        return()=>{active=false;};
    }, [isOpen,listAttempt,scope]);

    // Load messages when conversation changes
    useEffect(() => {
        let cancelled = false;
        const version = viewVersion.current;
        if (currentConversation && skipLoad.current === currentConversation.id) {
            skipLoad.current = null;
            setHistoryLoading(false);setHistoryFailed(false);
            return;
        }
        async function loadConversationMessages() {
            if (!currentConversation || (virtual && isDemoMode())) {
                setMessages([]);
                setHistoryLoading(false);setHistoryFailed(false);
                return;
            }
            setHistoryLoading(true);setHistoryFailed(false);
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
                if (!cancelled && version === viewVersion.current) {setMessages([]);setHistoryFailed(true);}
            } finally {
                if(!cancelled&&version===viewVersion.current)setHistoryLoading(false);
            }
        }
        loadConversationMessages();
        return () => { cancelled = true; };
    }, [currentConversation,historyAttempt,virtual]);

    // Replies stay with their originating conversation even when the user
    // opens another conversation while the server is answering.
    const handleSendMessage = useCallback(async (text: string) => {
        const canContinue = () => mounted.current && (!scope || !isDemoMode());
        if (!text.trim() || sending.current || historyLoading || historyFailed || !canContinue()) return;
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
            const title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
            if (!conversationId) {
                const newConv = await (scope
                    ? createConversation(title, undefined, scope)
                    : createConversation(title, selectedCar?.id));
                if (!canContinue()) return;
                conversationId = newConv.id;
                if (version === viewVersion.current) {
                    skipLoad.current = newConv.id;
                    setCurrentConversation(newConv);
                }
                setConversations(prev => [newConv, ...prev]);
            }

            // Save user message
            const savedQuestion = await saveMessage(conversationId, 'user', [{ type: 'text', text }]);
            userSaved = true;
            if (!canContinue()) return;

            // Virtual history is loaded by the server using the saved question as its boundary.
            const responseText = scope
                ? await chatViaEdge([], text, {}, undefined, {
                    mode: scope.mode,
                    sessionId: scope.sessionId,
                    conversationId,
                    messageId: savedQuestion.id,
                })
                : await chatViaEdge(messages.slice(-10).map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: m.content,
                })), text, {}, chatCarId);
            if (!canContinue()) return;

            // Save assistant message
            const assistantMessageId = crypto.randomUUID();
            await saveMessage(conversationId, 'assistant', [{ type: 'text', text: responseText }]);
            if (!canContinue()) return;

            if (version === viewVersion.current) setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: responseText,
            }]);

            // Update conversation title if this was the first message
            if (messages.length === 0 && canContinue()) {
                await updateConversationTitle(conversationId, title);
                if (!canContinue()) return;
                setConversations(prev => prev.map(c =>
                    c.id === conversationId ? { ...c, title: text.slice(0, 50) } : c
                ));
            }
        } catch (error) {
            if (!canContinue()) return;
            console.error('Chat error:', error);
            const kind = error instanceof AiError ? error.kind : 'unavailable';
            if (!scope || version === viewVersion.current) {
                const errorMessage = kind === 'limit_reached' ? 'assistant.limitReached'
                    : kind === 'context_not_found' ? 'modes.coach.contextNotFound'
                    : kind === 'development_disabled' ? 'assistant.providerErrors.developmentDisabled'
                    : kind === 'not_configured' ? scope ? 'modes.coach.notConfigured' : 'assistant.notConfigured'
                    : kind === 'unavailable' && scope ? 'modes.coach.replyFailed'
                    : 'assistant.replyFailed';
                toast({ title: t('assistant.errorTitle'), description: t(errorMessage), variant: 'destructive' });
            }
            // Keep questions already persisted when only the reply failed.
            if (!userSaved && version === viewVersion.current) setMessages(prev => prev.filter(m => m.id !== userMessageId));
        } finally {
            sending.current = false;
            if (mounted.current) setLoading(false);
        }
    }, [currentConversation, selectedCar, chatCarId, messages, toast, t,historyLoading,historyFailed,scope]);

    const handleNewConversation = () => {
        viewVersion.current++;
        setCurrentConversation(null);
        setMessages([]);
        setHistoryLoading(false);setHistoryFailed(false);
        setInput('');
        setSidebarOpen(false);
    };

    const handleSelectConversation = (conv: ChatConversation) => {
        if(currentConversation?.id===conv.id){setSidebarOpen(false);return;}
        viewVersion.current++;
        setMessages([]);
        setHistoryLoading(true);setHistoryFailed(false);
        setInput('');
        setCurrentConversation(conv);
        setSidebarOpen(false);
    };

    const handleDeleteConversation = async (id: string) => {
        if (scope && isDemoMode()) return;
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
                    onCloseAutoFocus={restoreFocus ? (event) => {
                        event.preventDefault();
                        restoreFocus();
                    } : undefined}
                    className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-2xl animate-in slide-in-from-right duration-300 focus:outline-none sm:inset-y-4 sm:left-auto sm:right-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl"
                >
                <CardHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 gap-3 border-b p-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <BrandLogo alt="" />
                            <div className="min-w-0">
                                <DialogPrimitive.Title asChild>
                                    <CardTitle className="text-lg">{scope ? t('modes.coach.title') : 'Xpeed'}</CardTitle>
                                </DialogPrimitive.Title>
                                {scope ? (
                                    <Link
                                        to={sessionPath(scope.sessionId)}
                                        onClick={onClose}
                                        className="block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                        title={scope.label}
                                    >
                                        {scope.label}
                                    </Link>
                                ) : (
                                    <p className="truncate text-xs text-muted-foreground">
                                        {chatCar?.name || t('assistant.noCarSelected', 'No car selected')}
                                    </p>
                                )}
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

                {listFailed&&<div role="alert" className="space-y-2 border-b p-4 text-sm">
                    <p>{t('assistant.conversationsFailed')}</p>
                    <Button variant="outline" onClick={()=>setListAttempt(value=>value+1)}>{t('problems.retry','Try again')}</Button>
                </div>}

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
                            {historyFailed ? <div role="alert" className="space-y-3 text-sm">
                                <p>{t('assistant.historyFailed')}</p>
                                <Button variant="outline" onClick={()=>setHistoryAttempt(value=>value+1)}>{t('problems.retry','Try again')}</Button>
                            </div> : historyLoading ? <p role="status">{t('common.loading','Loading…')}</p> : messages.length === 0 && !loading ? (
                                <ChatWelcome virtual={virtual} carName={chatCar?.name} selectPrompt={setInput} />
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
                            disabled={historyLoading||historyFailed}
                            placeholder={scope ? t('modes.coach.placeholder') : undefined}
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
