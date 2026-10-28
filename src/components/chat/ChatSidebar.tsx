import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatConversation } from '@/lib/chat/types';

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
                        <Button variant="ghost" size="icon" onClick={onNewConversation} className="h-8 w-8" aria-label={t('assistant.newChat', 'New chat')}>
                            <Plus className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 md:hidden" aria-label={t('assistant.close', 'Close')}>
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
                                        "group flex items-center gap-2 rounded-lg p-2 cursor-pointer transition-colors",
                                        currentConversationId === conv.id
                                            ? "bg-primary/10 text-primary"
                                            : "hover:bg-muted"
                                    )}
                                    onClick={() => onSelectConversation(conv)}
                                >
                                    <MessageSquare className="h-4 w-4 flex-shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm truncate">{conv.title}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {new Date(conv.updated_at).toLocaleDateString(i18n.resolvedLanguage || undefined)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                        aria-label={t('assistant.deleteChat', 'Delete conversation')}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDeleteConversation(conv.id);
                                        }}
                                    >
                                        <Trash2 className="h-3 w-3 text-destructive" />
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
