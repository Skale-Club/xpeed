import { useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Loader2 } from 'lucide-react';

interface ChatInputProps {
    input: string;
    setInput: (value: string) => void;
    onSend: (message: string) => void;
    isLoading: boolean;
    disabled?: boolean;
}

export function ChatInput({ input, setInput, onSend, isLoading, disabled }: ChatInputProps) {
    const { t } = useTranslation();
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    useLayoutEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = '0px';
            textareaRef.current.style.height = `${Math.max(48, Math.min(textareaRef.current.scrollHeight, 160))}px`;
        }
    }, [input]);

    const handleSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (input.trim() && !isLoading && !disabled) {
            onSend(input.trim());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <form onSubmit={handleSubmit} className="shrink-0 border-t bg-card p-3 sm:p-4">
            <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={disabled ? t('assistant.unavailable', 'The assistant is not available right now') : t('assistant.placeholder', 'Ask anything about your car…')}
                    aria-label={t('assistant.message', 'Message')}
                    disabled={isLoading || disabled}
                    className="min-h-12 max-h-40 min-w-0 flex-1 resize-none rounded-xl border-0 bg-transparent px-2 py-3 text-base leading-6 shadow-none placeholder:text-center focus-visible:ring-0 focus-visible:ring-offset-0"
                    rows={1}
                />
                <Button
                    type="submit"
                    size="icon"
                    disabled={!input.trim() || isLoading || disabled}
                    className="mb-0.5 h-11 w-11 shrink-0 rounded-xl"
                    aria-label={t('assistant.send', 'Send')}
                >
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Send className="h-4 w-4" />
                    )}
                </Button>
            </div>
            <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
                {t('assistant.enterHint', 'Press Enter to send, Shift+Enter for a new line')}
            </p>
        </form>
    );
}
