import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SquarePen, Trash2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatConversation } from '@/lib/chat/types';
import { formatAppDate } from '@/lib/app-date';

interface ChatSidebarProps {
    conversations: ChatConversation[];
    currentConversationId?: string;
    onSelectConversation: (conv: ChatConversation) => void;
    onDeleteConversation: (id: string) => void;
    onNewConversation: () => void;
}

export function ChatSidebar({
    conversations,
    currentConversationId,
    onSelectConversation,
    onDeleteConversation,
    onNewConversation,
}: ChatSidebarProps) {
    const { t, i18n } = useTranslation();
    const titleId = useId();
    return (
            <section id="chat-history" aria-labelledby={titleId} className="flex min-h-0 w-full flex-1 flex-col bg-card">
                <div className="shrink-0 space-y-3 border-b p-4">
                    <h2 id={titleId} className="font-semibold">{t('assistant.pastChats', 'Past conversations')}</h2>
                    <Button variant="outline" onClick={onNewConversation} className="h-11 w-full">
                        <SquarePen className="h-4 w-4" />{t('assistant.newChat', 'New chat')}
                    </Button>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                    <div className="p-2 space-y-1">
                        {conversations.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center p-4">
                                {t('assistant.noChats', 'No conversations yet')}
                            </p>
                        ) : (
                            conversations.map((conv) => (
                                <div
                                    key={conv.id}
                                    className={cn(
                                        "group flex items-center gap-1 rounded-lg transition-colors",
                                        currentConversationId === conv.id
                                            ? "bg-primary/10 text-primary"
                                            : "hover:bg-muted"
                                    )}
                                >
                                    <button
                                        type="button"
                                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg p-2 text-left"
                                        aria-current={currentConversationId === conv.id ? 'true' : undefined}
                                        onClick={() => onSelectConversation(conv)}
                                    >
                                        <MessageSquare className="h-4 w-4 flex-shrink-0" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm">{conv.title}</span>
                                            <span className="block text-xs text-muted-foreground">
                                                {formatAppDate(new Date(conv.updated_at), i18n.resolvedLanguage, { dateStyle: 'short' })}
                                            </span>
                                        </span>
                                    </button>
                                    {/* Always visible on touch screens; on a mouse it appears on hover or focus. */}
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 shrink-0 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                                        aria-label={t('assistant.deleteChat', 'Delete conversation')}
                                        onClick={() => onDeleteConversation(conv.id)}
                                    >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>
            </section>
    );
}
