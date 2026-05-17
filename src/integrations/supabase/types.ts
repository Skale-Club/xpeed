export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          created_at: string
          encrypted: boolean
          id: string
          setting_key: string
          setting_value: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          encrypted?: boolean
          id?: string
          setting_key: string
          setting_value?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          encrypted?: boolean
          id?: string
          setting_key?: string
          setting_value?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      car_profiles: {
        Row: {
          created_at: string
          id: string
          is_admin: boolean | null
          name: string
          notes: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_admin?: boolean | null
          name?: string
          notes?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_admin?: boolean | null
          name?: string
          notes?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "car_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      parameter_rules: {
        Row: {
          canonical_key: string
          car_profile_id: string | null
          created_at: string
          critical_max: number | null
          critical_min: number | null
          id: string
          label: string
          min_duration_seconds: number
          normal_max: number | null
          normal_min: number | null
          notes: string | null
          parameter_key: string
          unit: string | null
          warn_max: number | null
          warn_min: number | null
        }
        Insert: {
          canonical_key: string
          car_profile_id?: string | null
          created_at?: string
          critical_max?: number | null
          critical_min?: number | null
          id?: string
          label: string
          min_duration_seconds?: number
          normal_max?: number | null
          normal_min?: number | null
          notes?: string | null
          parameter_key: string
          unit?: string | null
          warn_max?: number | null
          warn_min?: number | null
        }
        Update: {
          canonical_key?: string
          car_profile_id?: string | null
          created_at?: string
          critical_max?: number | null
          critical_min?: number | null
          id?: string
          label?: string
          min_duration_seconds?: number
          normal_max?: number | null
          normal_min?: number | null
          notes?: string | null
          parameter_key?: string
          unit?: string | null
          warn_max?: number | null
          warn_min?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "parameter_rules_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_flags: {
        Row: {
          canonical_key: string
          created_at: string
          evidence: Json | null
          id: string
          message: string
          parameter_key: string
          resolved: boolean | null
          session_id: string
          severity: string
        }
        Insert: {
          canonical_key: string
          created_at?: string
          evidence?: Json | null
          id?: string
          message: string
          parameter_key: string
          resolved?: boolean | null
          session_id: string
          severity: string
        }
        Update: {
          canonical_key?: string
          created_at?: string
          evidence?: Json | null
          id?: string
          message?: string
          parameter_key?: string
          resolved?: boolean | null
          session_id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_flags_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_rows: {
        Row: {
          created_at: string
          data: Json
          id: string
          session_id: string
          t_seconds: number | null
          t_timestamp: string | null
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          session_id: string
          t_seconds?: number | null
          t_timestamp?: string | null
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          session_id?: string
          t_seconds?: number | null
          t_timestamp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_rows_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          car_profile_id: string | null
          columns: Json | null
          created_at: string
          duration_seconds: number | null
          gemini_analysis: Json | null
          id: string
          row_count: number
          session_end: string | null
          session_start: string | null
          source_csv: string | null
          source_file_path: string | null
          source_filename: string
          summary: Json | null
          uploaded_at: string
          user_id: string | null
        }
        Insert: {
          car_profile_id?: string | null
          columns?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_analysis?: Json | null
          id?: string
          row_count?: number
          session_end?: string | null
          session_start?: string | null
          source_csv?: string | null
          source_file_path?: string | null
          source_filename: string
          summary?: Json | null
          uploaded_at?: string
          user_id?: string | null
        }
        Update: {
          car_profile_id?: string | null
          columns?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_analysis?: Json | null
          id?: string
          row_count?: number
          session_end?: string | null
          session_start?: string | null
          source_csv?: string | null
          source_file_path?: string | null
          source_filename?: string
          summary?: Json | null
          uploaded_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sessions_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_conversations: {
        Row: {
          id: string
          title: string
          user_id: string | null
          car_profile_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title?: string
          user_id?: string | null
          car_profile_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          title?: string
          user_id?: string | null
          car_profile_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_conversations_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          id: string
          conversation_id: string
          role: string
          parts: Json
          attachments: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          role: string
          parts?: Json
          attachments?: Json
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          role?: string
          parts?: Json
          attachments?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
  | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
  ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
    DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
  : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
    DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
  ? R
  : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
    DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] &
    DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
  ? R
  : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
  | keyof DefaultSchema["Tables"]
  | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
  ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
  : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Insert: infer I
  }
  ? I
  : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
    Insert: infer I
  }
  ? I
  : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
  | keyof DefaultSchema["Tables"]
  | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
  ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
  : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Update: infer U
  }
  ? U
  : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
    Update: infer U
  }
  ? U
  : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
  | keyof DefaultSchema["Enums"]
  | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
  ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
  : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
  | keyof DefaultSchema["CompositeTypes"]
  | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
  ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
  : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
