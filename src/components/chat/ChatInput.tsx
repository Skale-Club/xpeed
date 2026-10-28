import { useRef, useEffect } from 'react';
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
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = '44px';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [input]);

    const handleSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (input.trim() && !isLoading && !disabled) {
            onSend(input.trim());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <form onSubmit={handleSubmit} className="border-t p-4">
            <div className="flex items-end gap-2">
                <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={disabled ? t('assistant.unavailable', 'The assistant is not available right now') : t('assistant.placeholder', 'Ask anything about your car…')}
                    disabled={isLoading || disabled}
                    className="min-h-[44px] max-h-[200px] resize-none flex-1"
                    rows={1}
                />
                <Button
                    type="submit"
                    size="icon"
                    disabled={!input.trim() || isLoading || disabled}
                    className="h-11 w-11 flex-shrink-0"
                    aria-label={t('assistant.send', 'Send')}
                >
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Send className="h-4 w-4" />
                    )}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
                {t('assistant.enterHint', 'Press Enter to send, Shift+Enter for a new line')}
            </p>
        </form>
    );
}
