import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatConversation } from '@/lib/chat/types';
import { formatAppDate } from '@/lib/app-date';

interface ChatSidebarProps {
    isOpen: boolean;
    conversations: ChatConversation[];
    currentConversationId?: string;
    onSelectConversation: (conv: ChatConversation) => void;
    onDeleteConversation: (id: string) => void;
    onNewConversation: () => void;
    onClose: () => void;
}

export function ChatSidebar({
    isOpen,
    conversations,
    currentConversationId,
    onSelectConversation,
    onDeleteConversation,
    onNewConversation,
    onClose,
}: ChatSidebarProps) {
    const { t, i18n } = useTranslation();
    return (
        <>
            {/* Mobile overlay */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={onClose}
                />
            )}

            {/* Sidebar */}
            <div
                className={cn(
                    "w-64 border-r bg-muted/30 flex flex-col transition-all duration-300",
                    "fixed md:relative inset-y-0 left-0 z-50 md:z-auto",
                    isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
                )}
            >
                <div className="p-4 border-b flex items-center justify-between">
                    <h2 className="font-semibold">{t('assistant.pastChats', 'Past conversations')}</h2>
                    <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={onNewConversation} className="h-10 w-10" aria-label={t('assistant.newChat', 'New chat')}>
                            <Plus className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onClose} className="h-10 w-10 md:hidden" aria-label={t('assistant.close', 'Close')}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                <ScrollArea className="flex-1">
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
            </div>
        </>
    );
}
