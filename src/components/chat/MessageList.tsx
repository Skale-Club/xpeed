import { User } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

interface MessageListProps {
    messages: Message[];
    isLoading: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            {messages.map((message) => (
                <div
                    key={message.id}
                    className={cn(
                        "flex w-full gap-3",
                        message.role === 'user' ? "justify-end" : "justify-start"
                    )}
                >
                    {message.role === 'assistant' && (
                        <BrandLogo />
                    )}

                    <div
                        className={cn(
                            "rounded-2xl px-4 py-2 max-w-[80%]",
                            message.role === 'user'
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted"
                        )}
                    >
                        {message.role === 'assistant' ? (
                            <div className="prose prose-sm dark:prose-invert max-w-none">
                                <ReactMarkdown>{message.content}</ReactMarkdown>
                            </div>
                        ) : (
                            <p className="whitespace-pre-wrap">{message.content}</p>
                        )}
                    </div>

                    {message.role === 'user' && (
                        <div className="w-8 h-8 rounded-full bg-primary flex-shrink-0 flex items-center justify-center">
                            <User className="w-4 h-4 text-primary-foreground" />
                        </div>
                    )}
                </div>
            ))}

            {isLoading && (
                <div className="flex justify-start gap-3" role="status" aria-label={t('assistant.thinking', 'The assistant is thinking…')}>
                    <BrandLogo />
                    <div className="bg-muted rounded-2xl px-4 py-3">
                        <div className="flex items-center gap-1">
                            <span className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                            <span className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                            <span className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce"></span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
