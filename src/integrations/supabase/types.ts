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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
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
        Relationships: []
      }
      car_profiles: {
        Row: {
          country: string
          created_at: string
          engine_type: string | null
          id: string
          is_admin: boolean | null
          make: string | null
          model: string | null
          name: string
          notes: string | null
          ruleset_id: string | null
          trim: string | null
          user_id: string
          vin: string | null
          year: number | null
        }
        Insert: {
          country?: string
          created_at?: string
          engine_type?: string | null
          id?: string
          is_admin?: boolean | null
          make?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          ruleset_id?: string | null
          trim?: string | null
          user_id?: string
          vin?: string | null
          year?: number | null
        }
        Update: {
          country?: string
          created_at?: string
          engine_type?: string | null
          id?: string
          is_admin?: boolean | null
          make?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          ruleset_id?: string | null
          trim?: string | null
          user_id?: string
          vin?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "car_profiles_ruleset_id_fkey"
            columns: ["ruleset_id"]
            isOneToOne: false
            referencedRelation: "vehicle_rulesets"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_conversations: {
        Row: {
          car_profile_id: string | null
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          car_profile_id?: string | null
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          car_profile_id?: string | null
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
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
          attachments: Json
          conversation_id: string
          created_at: string
          id: string
          parts: Json
          role: string
        }
        Insert: {
          attachments?: Json
          conversation_id: string
          created_at?: string
          id?: string
          parts?: Json
          role: string
        }
        Update: {
          attachments?: Json
          conversation_id?: string
          created_at?: string
          id?: string
          parts?: Json
          role?: string
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
      maintenance_events: {
        Row: {
          car_profile_id: string
          cost: number | null
          created_at: string
          currency: string | null
          event_type: string
          id: string
          notes: string | null
          odometer_km: number | null
          performed_at: string
          shop: string | null
          user_id: string
        }
        Insert: {
          car_profile_id: string
          cost?: number | null
          created_at?: string
          currency?: string | null
          event_type: string
          id?: string
          notes?: string | null
          odometer_km?: number | null
          performed_at: string
          shop?: string | null
          user_id?: string
        }
        Update: {
          car_profile_id?: string
          cost?: number | null
          created_at?: string
          currency?: string | null
          event_type?: string
          id?: string
          notes?: string | null
          odometer_km?: number | null
          performed_at?: string
          shop?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_events_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
          user_id?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_authorization_codes: {
        Row: {
          client_id: string
          code: string
          code_challenge: string
          code_challenge_method: string
          expires_at: string
          redirect_uri: string
          scope: string | null
          used_at: string | null
          user_id: string
        }
        Insert: {
          client_id: string
          code: string
          code_challenge: string
          code_challenge_method?: string
          expires_at: string
          redirect_uri: string
          scope?: string | null
          used_at?: string | null
          user_id: string
        }
        Update: {
          client_id?: string
          code?: string
          code_challenge?: string
          code_challenge_method?: string
          expires_at?: string
          redirect_uri?: string
          scope?: string | null
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_authorization_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_id: string
          client_metadata: Json | null
          client_name: string
          created_at: string
          grant_types: string[]
          redirect_uris: string[]
          token_endpoint_auth_method: string
        }
        Insert: {
          client_id: string
          client_metadata?: Json | null
          client_name: string
          created_at?: string
          grant_types?: string[]
          redirect_uris: string[]
          token_endpoint_auth_method?: string
        }
        Update: {
          client_id?: string
          client_metadata?: Json | null
          client_name?: string
          created_at?: string
          grant_types?: string[]
          redirect_uris?: string[]
          token_endpoint_auth_method?: string
        }
        Relationships: []
      }
      oauth_refresh_tokens: {
        Row: {
          client_id: string
          expires_at: string
          issued_at: string
          previous_token_hash: string | null
          revoked_at: string | null
          scope: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          client_id: string
          expires_at: string
          issued_at?: string
          previous_token_hash?: string | null
          revoked_at?: string | null
          scope?: string | null
          token_hash: string
          user_id: string
        }
        Update: {
          client_id?: string
          expires_at?: string
          issued_at?: string
          previous_token_hash?: string | null
          revoked_at?: string | null
          scope?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_refresh_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      parameter_baselines: {
        Row: {
          canonical_key: string
          car_profile_id: string
          computed_at: string
          id: string
          mean: number
          sample_count: number
          stddev: number
          window_days: number
        }
        Insert: {
          canonical_key: string
          car_profile_id: string
          computed_at?: string
          id?: string
          mean: number
          sample_count: number
          stddev: number
          window_days: number
        }
        Update: {
          canonical_key?: string
          car_profile_id?: string
          computed_at?: string
          id?: string
          mean?: number
          sample_count?: number
          stddev?: number
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "parameter_baselines_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
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
          ruleset_id: string | null
          unit: string | null
          warn_max: number | null
          warn_min: number | null
          what_happened: string | null
          what_to_do: string | null
          why_it_matters: string | null
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
          ruleset_id?: string | null
          unit?: string | null
          warn_max?: number | null
          warn_min?: number | null
          what_happened?: string | null
          what_to_do?: string | null
          why_it_matters?: string | null
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
          ruleset_id?: string | null
          unit?: string | null
          warn_max?: number | null
          warn_min?: number | null
          what_happened?: string | null
          what_to_do?: string | null
          why_it_matters?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parameter_rules_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_rules_ruleset_id_fkey"
            columns: ["ruleset_id"]
            isOneToOne: false
            referencedRelation: "vehicle_rulesets"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          bucket: string
          count: number
          window_start: string
        }
        Insert: {
          bucket: string
          count?: number
          window_start?: string
        }
        Update: {
          bucket?: string
          count?: number
          window_start?: string
        }
        Relationships: []
      }
      security_events: {
        Row: {
          created_at: string
          detail: Json
          event_type: string
          id: string
          ip: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          event_type: string
          id?: string
          ip?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          event_type?: string
          id?: string
          ip?: string | null
          user_id?: string | null
        }
        Relationships: []
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
      session_photos: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          photo_type: string | null
          session_id: string
          storage_path: string
          user_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          photo_type?: string | null
          session_id: string
          storage_path: string
          user_id?: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          photo_type?: string | null
          session_id?: string
          storage_path?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_photos_session_id_fkey"
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
          active_dtcs: Json | null
          car_profile_id: string | null
          columns: Json | null
          created_at: string
          duration_seconds: number | null
          gemini_analysis: Json | null
          id: string
          processing_version: number
          report: Json | null
          report_version: number
          row_count: number
          ruleset_id: string | null
          ruleset_matched_via: string | null
          session_end: string | null
          session_start: string | null
          source_csv: string | null
          source_file_path: string | null
          source_filename: string
          summary: Json | null
          uploaded_at: string
          user_id: string
        }
        Insert: {
          active_dtcs?: Json | null
          car_profile_id?: string | null
          columns?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_analysis?: Json | null
          id?: string
          processing_version?: number
          report?: Json | null
          report_version?: number
          row_count?: number
          ruleset_id?: string | null
          ruleset_matched_via?: string | null
          session_end?: string | null
          session_start?: string | null
          source_csv?: string | null
          source_file_path?: string | null
          source_filename: string
          summary?: Json | null
          uploaded_at?: string
          user_id?: string
        }
        Update: {
          active_dtcs?: Json | null
          car_profile_id?: string | null
          columns?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_analysis?: Json | null
          id?: string
          processing_version?: number
          report?: Json | null
          report_version?: number
          row_count?: number
          ruleset_id?: string | null
          ruleset_matched_via?: string | null
          session_end?: string | null
          session_start?: string | null
          source_csv?: string | null
          source_file_path?: string | null
          source_filename?: string
          summary?: Json | null
          uploaded_at?: string
          user_id?: string
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
            foreignKeyName: "sessions_ruleset_id_fkey"
            columns: ["ruleset_id"]
            isOneToOne: false
            referencedRelation: "vehicle_rulesets"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_reports: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          session_id: string
          user_id: string
          view_count: number
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          session_id: string
          user_id?: string
          view_count?: number
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          session_id?: string
          user_id?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "shared_reports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_quotas: {
        Row: {
          created_at: string
          id: string
          kind: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          user_id?: string
        }
        Relationships: []
      }
      vehicle_issue_occurrences: {
        Row: {
          created_at: string
          evidence: Json | null
          id: string
          issue_id: string
          occurred_at: string
          session_id: string
          severity: string
        }
        Insert: {
          created_at?: string
          evidence?: Json | null
          id?: string
          issue_id: string
          occurred_at: string
          session_id: string
          severity: string
        }
        Update: {
          created_at?: string
          evidence?: Json | null
          id?: string
          issue_id?: string
          occurred_at?: string
          session_id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_issue_occurrences_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "vehicle_issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_issue_occurrences_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_issues: {
        Row: {
          canonical_key: string
          car_profile_id: string
          created_at: string
          details: Json | null
          first_seen_at: string
          first_session_id: string | null
          id: string
          last_seen_at: string
          last_session_id: string | null
          recurrence_count: number
          resolved_at: string | null
          resolved_note: string | null
          severity: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canonical_key: string
          car_profile_id: string
          created_at?: string
          details?: Json | null
          first_seen_at: string
          first_session_id?: string | null
          id?: string
          last_seen_at: string
          last_session_id?: string | null
          recurrence_count?: number
          resolved_at?: string | null
          resolved_note?: string | null
          severity: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          canonical_key?: string
          car_profile_id?: string
          created_at?: string
          details?: Json | null
          first_seen_at?: string
          first_session_id?: string | null
          id?: string
          last_seen_at?: string
          last_session_id?: string | null
          recurrence_count?: number
          resolved_at?: string | null
          resolved_note?: string | null
          severity?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_issues_car_profile_id_fkey"
            columns: ["car_profile_id"]
            isOneToOne: false
            referencedRelation: "car_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_issues_first_session_id_fkey"
            columns: ["first_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_issues_last_session_id_fkey"
            columns: ["last_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_makes_cache: {
        Row: {
          country: string
          fetched_at: string
          id: number
          make_id: number
          make_name: string
        }
        Insert: {
          country?: string
          fetched_at?: string
          id?: number
          make_id: number
          make_name: string
        }
        Update: {
          country?: string
          fetched_at?: string
          id?: number
          make_id?: number
          make_name?: string
        }
        Relationships: []
      }
      vehicle_models_cache: {
        Row: {
          country: string
          fetched_at: string
          id: number
          make_id: number
          make_name: string
          model_name: string
        }
        Insert: {
          country?: string
          fetched_at?: string
          id?: number
          make_id: number
          make_name: string
          model_name: string
        }
        Update: {
          country?: string
          fetched_at?: string
          id?: number
          make_id?: number
          make_name?: string
          model_name?: string
        }
        Relationships: []
      }
      vehicle_rulesets: {
        Row: {
          applies_to: Json
          base_ruleset_id: string | null
          created_at: string
          id: string
          is_builtin: boolean
          name: string
        }
        Insert: {
          applies_to?: Json
          base_ruleset_id?: string | null
          created_at?: string
          id: string
          is_builtin?: boolean
          name: string
        }
        Update: {
          applies_to?: Json
          base_ruleset_id?: string | null
          created_at?: string
          id?: string
          is_builtin?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_rulesets_base_ruleset_id_fkey"
            columns: ["base_ruleset_id"]
            isOneToOne: false
            referencedRelation: "vehicle_rulesets"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_rate_limit: {
        Args: { p_bucket: string; p_max: number; p_window_seconds: number }
        Returns: boolean
      }
      consume_quota: {
        Args: { p_kind: string; p_limit: number; p_user_id: string }
        Returns: number
      }
      exec_sql: { Args: { query: string }; Returns: undefined }
      get_dashboard_stats: {
        Args: { p_car_profile_id: string; p_date_from?: string }
        Returns: Json
      }
      get_shared_report: { Args: { p_id: string }; Returns: Json }
      is_admin_user: { Args: never; Returns: boolean }
      is_current_user_admin: { Args: never; Returns: boolean }
      refresh_parameter_baselines: {
        Args: { p_car_profile_id: string }
        Returns: undefined
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
