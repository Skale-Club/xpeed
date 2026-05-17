// Chat Database Operations
// Handles all Supabase interactions for the chat system

import { supabase } from '@/integrations/supabase/client';
import type { ChatMessage, ChatConversation, ChatContext, MessagePart, Attachment } from './types';
import { getSessions } from '@/lib/db';
import type { Json } from '@/integrations/supabase/types';

// Type helper to convert DB row to ChatConversation
function toConversation(row: {
    id: string;
    title: string;
    user_id: string | null;
    car_profile_id: string | null;
    created_at: string;
    updated_at: string;
}): ChatConversation {
    return {
        id: row.id,
        title: row.title,
        user_id: row.user_id || '',
        car_profile_id: row.car_profile_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// Type helper to convert DB row to ChatMessage
function toChatMessage(row: {
    id: string;
    conversation_id: string;
    role: string;
    parts: Json;
    attachments: Json;
    created_at: string;
}): ChatMessage {
    return {
        id: row.id,
        role: row.role as 'user' | 'assistant',
        parts: (row.parts || []) as unknown as MessagePart[],
        attachments: (row.attachments || []) as unknown as Attachment[],
        createdAt: row.created_at,
    };
}

// Get all conversations for the current user
export async function getConversations(): Promise<ChatConversation[]> {
    const { data, error } = await supabase
        .from('chat_conversations')
        .select('*')
        .order('updated_at', { ascending: false });

    if (error) {
        console.error('Failed to fetch conversations:', error);
        throw error;
    }

    return (data || []).map(toConversation);
}

// Get a single conversation by ID
export async function getConversation(id: string): Promise<ChatConversation | null> {
    const { data, error } = await supabase
        .from('chat_conversations')
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        console.error('Failed to fetch conversation:', error);
        throw error;
    }

    return data ? toConversation(data) : null;
}

// Create a new conversation
export async function createConversation(
    title: string = 'New Conversation',
    carProfileId?: string
): Promise<ChatConversation> {
    // Explicitly fetch + set user_id: the chat_conversations RLS INSERT policy
    // checks `auth.uid() = user_id`, and the table has no BEFORE INSERT trigger
    // to auto-populate it (unlike sessions / car_profiles). Without this the
    // INSERT silently fails with RLS rejection.
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
        throw new Error('User not authenticated');
    }

    const { data, error } = await supabase
        .from('chat_conversations')
        .insert({
            title,
            car_profile_id: carProfileId || null,
            user_id: user.id,
        })
        .select()
        .single();

    if (error) {
        console.error('Failed to create conversation:', error);
        throw error;
    }

    return toConversation(data);
}

// Update conversation title
export async function updateConversationTitle(
    id: string,
    title: string
): Promise<void> {
    const { error } = await supabase
        .from('chat_conversations')
        .update({ title })
        .eq('id', id);

    if (error) {
        console.error('Failed to update conversation:', error);
        throw error;
    }
}

// Delete a conversation and all its messages
export async function deleteConversation(id: string): Promise<void> {
    const { error } = await supabase
        .from('chat_conversations')
        .delete()
        .eq('id', id);

    if (error) {
        console.error('Failed to delete conversation:', error);
        throw error;
    }
}

// Get all messages for a conversation
export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
    const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('Failed to fetch messages:', error);
        throw error;
    }

    return (data || []).map(toChatMessage);
}

// Save a message to the database
export async function saveMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    parts: MessagePart[],
    attachments: Attachment[] = []
): Promise<ChatMessage> {
    const { data, error } = await supabase
        .from('chat_messages')
        .insert({
            conversation_id: conversationId,
            role,
            parts: parts as unknown as Json,
            attachments: attachments as unknown as Json,
        })
        .select()
        .single();

    if (error) {
        console.error('Failed to save message:', error);
        throw error;
    }

    return toChatMessage(data);
}

// Delete all messages in a conversation (for regeneration)
export async function deleteMessagesFrom(conversationId: string, fromMessageId: string): Promise<void> {
    // Get the timestamp of the message to delete from
    const { data: message, error: fetchError } = await supabase
        .from('chat_messages')
        .select('created_at')
        .eq('id', fromMessageId)
        .single();

    if (fetchError) {
        console.error('Failed to fetch message:', fetchError);
        throw fetchError;
    }

    // Delete all messages from that point
    const { error } = await supabase
        .from('chat_messages')
        .delete()
        .eq('conversation_id', conversationId)
        .gte('created_at', message.created_at);

    if (error) {
        console.error('Failed to delete messages:', error);
        throw error;
    }
}

// Build context for the AI from vehicle data
export async function buildChatContext(carProfileId?: string | null): Promise<ChatContext> {
    if (!carProfileId) {
        return {
            vehicle: null,
            recentSessions: [],
            sessionCount: 0,
        };
    }

    try {
        // Get car profile
        const { data: carProfile, error: carError } = await supabase
            .from('car_profiles')
            .select('*')
            .eq('id', carProfileId)
            .single();

        if (carError) {
            console.error('Failed to fetch car profile:', carError);
        }

        // Get sessions
        const sessions = await getSessions(carProfileId);
        const recentSessions = sessions.slice(0, 5).map((s) => ({
            date: s.uploaded_at,
            filename: s.source_filename,
            duration: s.duration_seconds,
            summary: s.summary as Record<string, unknown> | null,
        }));

        return {
            vehicle: carProfile
                ? {
                    name: carProfile.name,
                    notes: carProfile.notes,
                }
                : null,
            recentSessions,
            sessionCount: sessions.length,
        };
    } catch (error) {
        console.error('Failed to build chat context:', error);
        return {
            vehicle: null,
            recentSessions: [],
            sessionCount: 0,
        };
    }
}
