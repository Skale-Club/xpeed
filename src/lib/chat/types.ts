// Chat System Types
// Compatible with Vercel AI SDK message format

export interface MessagePart {
    type: 'text' | 'file';
    text?: string;
    url?: string;
    mediaType?: string;
    filename?: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    parts: MessagePart[];
    attachments?: Attachment[];
    createdAt: string;
}

export interface Attachment {
    name: string;
    url: string;
    contentType: string;
}

export interface ChatConversation {
    id: string;
    title: string;
    user_id: string;
    car_profile_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface ChatContext {
    vehicle: {
        name: string;
        notes: string | null;
        make?: string | null;
        model?: string | null;
        year?: number | null;
        vin?: string | null;
        engine_type?: string | null;
    } | null;
    recentSessions: Array<{
        date: string;
        filename: string;
        duration: number | null;
        summary: Record<string, unknown> | null;
    }>;
    sessionCount: number;
    // Improvement D2: enriched fields for trend-aware AI answers
    trends?: Array<{
        canonical_key: string;
        label?: string;
        current_avg: number;
        historic_avg: number;
        delta_pct: number;
        trend: 'improving' | 'declining' | 'stable';
        sample_count: number;
    }>;
    activeDtcs?: string[];
    maintenance?: Array<{ type: string; date: string; odometer?: number | null }>;
}

// Helper to convert DB message to UI message
export function dbMessageToUIMessage(dbMsg: {
    id: string;
    role: string;
    parts: MessagePart[];
    attachments: Attachment[];
    created_at: string;
}): ChatMessage {
    return {
        id: dbMsg.id,
        role: dbMsg.role as 'user' | 'assistant',
        parts: dbMsg.parts,
        attachments: dbMsg.attachments,
        createdAt: dbMsg.created_at,
    };
}

// Helper to convert UI message to DB format
export function uiMessageToDBMessage(msg: ChatMessage, conversationId: string) {
    return {
        conversation_id: conversationId,
        role: msg.role,
        parts: msg.parts,
        attachments: msg.attachments || [],
    };
}

// Helper to extract text from message parts
export function getMessageText(message: ChatMessage): string {
    return message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('\n');
}

// Helper to create a text message
export function createTextMessage(
    role: 'user' | 'assistant',
    text: string,
    id?: string
): ChatMessage {
    return {
        id: id || crypto.randomUUID(),
        role,
        parts: [{ type: 'text', text }],
        attachments: [],
        createdAt: new Date().toISOString(),
    };
}
