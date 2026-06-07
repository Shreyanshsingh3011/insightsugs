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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          delay_note: string | null
          delay_reason_id: string | null
          department: string | null
          depends_on: string | null
          description: string | null
          due_date: string | null
          id: string
          project_id: string
          start_date: string | null
          status: Database["public"]["Enums"]["activity_status"]
          tat_days: number | null
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          delay_note?: string | null
          delay_reason_id?: string | null
          department?: string | null
          depends_on?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          project_id: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["activity_status"]
          tat_days?: number | null
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          delay_note?: string | null
          delay_reason_id?: string | null
          department?: string | null
          depends_on?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          project_id?: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["activity_status"]
          tat_days?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_delay_reason_id_fkey"
            columns: ["delay_reason_id"]
            isOneToOne: false
            referencedRelation: "delay_reasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_depends_on_fkey"
            columns: ["depends_on"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_messages: {
        Row: {
          alert_id: string
          author_id: string
          body: string
          created_at: string
          id: string
        }
        Insert: {
          alert_id: string
          author_id: string
          body: string
          created_at?: string
          id?: string
        }
        Update: {
          alert_id?: string
          author_id?: string
          body?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_messages_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_recipients: {
        Row: {
          alert_id: string
          channel: string
          created_at: string
          delivered_at: string | null
          email: string
          error: string | null
          id: string
          name: string | null
          user_id: string | null
        }
        Insert: {
          alert_id: string
          channel: string
          created_at?: string
          delivered_at?: string | null
          email: string
          error?: string | null
          id?: string
          name?: string | null
          user_id?: string | null
        }
        Update: {
          alert_id?: string
          channel?: string
          created_at?: string
          delivered_at?: string | null
          email?: string
          error?: string | null
          id?: string
          name?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alert_recipients_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          activity: string
          created_at: string
          flag_id: string
          id: string
          reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          root_cause: string | null
          sent_by: string
          severity: string | null
          source: string | null
          stage: string | null
          status: string
          updated_at: string
        }
        Insert: {
          activity: string
          created_at?: string
          flag_id: string
          id?: string
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          sent_by: string
          severity?: string | null
          source?: string | null
          stage?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          activity?: string
          created_at?: string
          flag_id?: string
          id?: string
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          sent_by?: string
          severity?: string | null
          source?: string | null
          stage?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          activity_id: string | null
          actor_id: string | null
          created_at: string
          details: Json
          event_type: string
          id: string
          project_id: string | null
        }
        Insert: {
          activity_id?: string | null
          actor_id?: string | null
          created_at?: string
          details?: Json
          event_type: string
          id?: string
          project_id?: string | null
        }
        Update: {
          activity_id?: string | null
          actor_id?: string | null
          created_at?: string
          details?: Json
          event_type?: string
          id?: string
          project_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      concern_messages: {
        Row: {
          author_id: string
          body: string
          concern_id: string
          created_at: string
          id: string
        }
        Insert: {
          author_id: string
          body: string
          concern_id: string
          created_at?: string
          id?: string
        }
        Update: {
          author_id?: string
          body?: string
          concern_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "concern_messages_concern_id_fkey"
            columns: ["concern_id"]
            isOneToOne: false
            referencedRelation: "concerns"
            referencedColumns: ["id"]
          },
        ]
      }
      concerns: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          activity: string | null
          body: string
          created_at: string
          id: string
          last_nudged_at: string | null
          raised_by: string
          raised_by_dept: string | null
          registry_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          row_index: number | null
          severity: string
          status: string
          target_dept: string
          title: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          activity?: string | null
          body?: string
          created_at?: string
          id?: string
          last_nudged_at?: string | null
          raised_by: string
          raised_by_dept?: string | null
          registry_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          severity?: string
          status?: string
          target_dept: string
          title: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          activity?: string | null
          body?: string
          created_at?: string
          id?: string
          last_nudged_at?: string | null
          raised_by?: string
          raised_by_dept?: string | null
          registry_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          severity?: string
          status?: string
          target_dept?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      copilot_messages: {
        Row: {
          citations: Json
          content: string
          created_at: string
          id: string
          role: string
          scope: Json
          user_id: string
        }
        Insert: {
          citations?: Json
          content: string
          created_at?: string
          id?: string
          role: string
          scope?: Json
          user_id: string
        }
        Update: {
          citations?: Json
          content?: string
          created_at?: string
          id?: string
          role?: string
          scope?: Json
          user_id?: string
        }
        Relationships: []
      }
      delay_reasons: {
        Row: {
          active: boolean
          code: string
          id: string
          label: string
        }
        Insert: {
          active?: boolean
          code: string
          id?: string
          label: string
        }
        Update: {
          active?: boolean
          code?: string
          id?: string
          label?: string
        }
        Relationships: []
      }
      doc_folders: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          parent_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          parent_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          parent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "doc_folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "doc_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          owner_id: string
          page_no: number | null
          token_count: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          owner_id: string
          page_no?: number | null
          token_count?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          owner_id?: string
          page_no?: number | null
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          folder_id: string | null
          id: string
          key_points: Json | null
          mime_type: string
          name: string
          owner_id: string
          page_count: number | null
          size_bytes: number
          status: Database["public"]["Enums"]["document_status"]
          status_error: string | null
          storage_path: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          folder_id?: string | null
          id?: string
          key_points?: Json | null
          mime_type: string
          name: string
          owner_id: string
          page_count?: number | null
          size_bytes?: number
          status?: Database["public"]["Enums"]["document_status"]
          status_error?: string | null
          storage_path: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          folder_id?: string | null
          id?: string
          key_points?: Json | null
          mime_type?: string
          name?: string
          owner_id?: string
          page_count?: number | null
          size_bytes?: number
          status?: Database["public"]["Enums"]["document_status"]
          status_error?: string | null
          storage_path?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "doc_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      email_group_members: {
        Row: {
          created_at: string
          email: string
          group_id: string
          id: string
          name: string | null
        }
        Insert: {
          created_at?: string
          email: string
          group_id: string
          id?: string
          name?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          group_id?: string
          id?: string
          name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "email_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      email_groups: {
        Row: {
          applies_to: Json
          created_at: string
          description: string | null
          id: string
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          applies_to?: Json
          created_at?: string
          description?: string | null
          id?: string
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          applies_to?: Json
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      escalation_runs: {
        Row: {
          details: Json
          id: string
          notifications_created: number
          overdue_count: number
          ran_at: string
        }
        Insert: {
          details?: Json
          id?: string
          notifications_created?: number
          overdue_count?: number
          ran_at?: string
        }
        Update: {
          details?: Json
          id?: string
          notifications_created?: number
          overdue_count?: number
          ran_at?: string
        }
        Relationships: []
      }
      holidays: {
        Row: {
          holiday_date: string
          id: string
          label: string | null
        }
        Insert: {
          holiday_date: string
          id?: string
          label?: string | null
        }
        Update: {
          holiday_date?: string
          id?: string
          label?: string | null
        }
        Relationships: []
      }
      integrations: {
        Row: {
          api_key: string
          base_url: string
          key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          api_key?: string
          base_url?: string
          key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          api_key?: string
          base_url?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          activity_id: string | null
          body: string | null
          created_at: string
          id: string
          kind: string
          project_id: string | null
          read_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          activity_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          project_id?: string | null
          read_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          activity_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          project_id?: string | null
          read_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          department: string | null
          email: string
          full_name: string
          id: string
          manager_id: string | null
          sheet_ref: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          department?: string | null
          email?: string
          full_name?: string
          id: string
          manager_id?: string | null
          sheet_ref?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string | null
          email?: string
          full_name?: string
          id?: string
          manager_id?: string | null
          sheet_ref?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          project_id: string
          role: string
          user_id: string
        }
        Insert: {
          project_id: string
          role?: string
          user_id: string
        }
        Update: {
          project_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          code: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          owner_id: string | null
          updated_at: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          owner_id?: string | null
          updated_at?: string
        }
        Update: {
          code?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          owner_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sheet_column_mappings: {
        Row: {
          canonical_field: string | null
          created_at: string
          id: string
          position: number
          sheet_registry_id: string
          source_header: string
        }
        Insert: {
          canonical_field?: string | null
          created_at?: string
          id?: string
          position?: number
          sheet_registry_id: string
          source_header: string
        }
        Update: {
          canonical_field?: string | null
          created_at?: string
          id?: string
          position?: number
          sheet_registry_id?: string
          source_header?: string
        }
        Relationships: [
          {
            foreignKeyName: "sheet_column_mappings_sheet_registry_id_fkey"
            columns: ["sheet_registry_id"]
            isOneToOne: false
            referencedRelation: "sheet_registry"
            referencedColumns: ["id"]
          },
        ]
      }
      sheet_registry: {
        Row: {
          apps_script_url: string
          created_at: string
          display_name: string
          id: string
          last_refreshed_at: string | null
          row_count: number
          sheet_type: Database["public"]["Enums"]["sheet_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          apps_script_url: string
          created_at?: string
          display_name: string
          id?: string
          last_refreshed_at?: string | null
          row_count?: number
          sheet_type: Database["public"]["Enums"]["sheet_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          apps_script_url?: string
          created_at?: string
          display_name?: string
          id?: string
          last_refreshed_at?: string | null
          row_count?: number
          sheet_type?: Database["public"]["Enums"]["sheet_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sheet_rows: {
        Row: {
          canonical: Json
          created_at: string
          extras: Json
          id: string
          row_index: number
          sheet_registry_id: string
        }
        Insert: {
          canonical?: Json
          created_at?: string
          extras?: Json
          id?: string
          row_index: number
          sheet_registry_id: string
        }
        Update: {
          canonical?: Json
          created_at?: string
          extras?: Json
          id?: string
          row_index?: number
          sheet_registry_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sheet_rows_sheet_registry_id_fkey"
            columns: ["sheet_registry_id"]
            isOneToOne: false
            referencedRelation: "sheet_registry"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      weekly_reports: {
        Row: {
          generated_at: string
          id: string
          summary: Json
          week_end: string
          week_start: string
        }
        Insert: {
          generated_at?: string
          id?: string
          summary?: Json
          week_end: string
          week_start: string
        }
        Update: {
          generated_at?: string
          id?: string
          summary?: Json
          week_end?: string
          week_start?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_see_project: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin_or_super: { Args: { _user_id: string }; Returns: boolean }
      is_alert_recipient: {
        Args: { _alert_id: string; _user_id: string }
        Returns: boolean
      }
      match_doc_chunks: {
        Args: {
          _match_count?: number
          _query: string
          _scope_document: string
          _scope_folder: string
          _user_id: string
        }
        Returns: {
          chunk_id: string
          content: string
          document_id: string
          document_name: string
          page_no: number
          similarity: number
        }[]
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      seed_default_doc_folders: {
        Args: { _user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      activity_status:
        | "pending"
        | "in_progress"
        | "completed"
        | "blocked"
        | "overdue"
      app_role: "super_admin" | "admin" | "user"
      document_status: "pending" | "processing" | "ready" | "failed"
      sheet_type:
        | "progress"
        | "material_reconciliation"
        | "procurement"
        | "contractor_billing"
        | "bill_tracking"
        | "pms"
        | "tat"
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
    Enums: {
      activity_status: [
        "pending",
        "in_progress",
        "completed",
        "blocked",
        "overdue",
      ],
      app_role: ["super_admin", "admin", "user"],
      document_status: ["pending", "processing", "ready", "failed"],
      sheet_type: [
        "progress",
        "material_reconciliation",
        "procurement",
        "contractor_billing",
        "bill_tracking",
        "pms",
        "tat",
      ],
    },
  },
} as const
