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
      agent_drafts: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          assigned_to: string | null
          body: string
          cc: Json
          channel: string
          confidence: number
          created_at: string
          created_by_rule: string | null
          dismiss_reason: string | null
          draft_type: string
          id: string
          payload: Json
          playbook_slug: string | null
          playbook_step: number | null
          recipient_email: string | null
          recipient_user_id: string | null
          send_result: Json | null
          sent_at: string | null
          snoozed_until: string | null
          source_key: string
          source_kind: string
          state: string
          subject: string | null
          title: string
          updated_at: string
          why: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_to?: string | null
          body: string
          cc?: Json
          channel?: string
          confidence?: number
          created_at?: string
          created_by_rule?: string | null
          dismiss_reason?: string | null
          draft_type: string
          id?: string
          payload?: Json
          playbook_slug?: string | null
          playbook_step?: number | null
          recipient_email?: string | null
          recipient_user_id?: string | null
          send_result?: Json | null
          sent_at?: string | null
          snoozed_until?: string | null
          source_key: string
          source_kind: string
          state?: string
          subject?: string | null
          title: string
          updated_at?: string
          why?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_to?: string | null
          body?: string
          cc?: Json
          channel?: string
          confidence?: number
          created_at?: string
          created_by_rule?: string | null
          dismiss_reason?: string | null
          draft_type?: string
          id?: string
          payload?: Json
          playbook_slug?: string | null
          playbook_step?: number | null
          recipient_email?: string | null
          recipient_user_id?: string | null
          send_result?: Json | null
          sent_at?: string | null
          snoozed_until?: string | null
          source_key?: string
          source_kind?: string
          state?: string
          subject?: string | null
          title?: string
          updated_at?: string
          why?: string | null
        }
        Relationships: []
      }
      agent_memory: {
        Row: {
          created_at: string
          id: string
          importance: number
          key: string
          kind: string
          source: string | null
          updated_at: string
          user_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          importance?: number
          key: string
          kind: string
          source?: string | null
          updated_at?: string
          user_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          importance?: number
          key?: string
          kind?: string
          source?: string | null
          updated_at?: string
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      agent_preferences: {
        Row: {
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          user_id: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      agent_run_events: {
        Row: {
          action_id: string | null
          actor_id: string | null
          agent: string
          created_at: string
          event: string
          id: string
          metadata: Json
          run_id: string | null
        }
        Insert: {
          action_id?: string | null
          actor_id?: string | null
          agent: string
          created_at?: string
          event: string
          id?: string
          metadata?: Json
          run_id?: string | null
        }
        Update: {
          action_id?: string | null
          actor_id?: string | null
          agent?: string
          created_at?: string
          event?: string
          id?: string
          metadata?: Json
          run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_events_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "pending_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          actor_id: string | null
          agent: string
          cost_credits: number | null
          created_at: string
          error: string | null
          feedback: number | null
          feedback_note: string | null
          finished_at: string | null
          handoff_from: string | null
          id: string
          input: Json
          latency_ms: number | null
          output: Json | null
          routed_to: string | null
          status: string
          tokens_in: number | null
          tokens_out: number | null
          tool_calls: Json
          trigger: string
        }
        Insert: {
          actor_id?: string | null
          agent: string
          cost_credits?: number | null
          created_at?: string
          error?: string | null
          feedback?: number | null
          feedback_note?: string | null
          finished_at?: string | null
          handoff_from?: string | null
          id?: string
          input?: Json
          latency_ms?: number | null
          output?: Json | null
          routed_to?: string | null
          status?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_calls?: Json
          trigger?: string
        }
        Update: {
          actor_id?: string | null
          agent?: string
          cost_credits?: number | null
          created_at?: string
          error?: string | null
          feedback?: number | null
          feedback_note?: string | null
          finished_at?: string | null
          handoff_from?: string | null
          id?: string
          input?: Json
          latency_ms?: number | null
          output?: Json | null
          routed_to?: string | null
          status?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_calls?: Json
          trigger?: string
        }
        Relationships: []
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
      briefing_preferences: {
        Row: {
          created_at: string
          overdue_priority: string
          sections: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          overdue_priority?: string
          sections?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          overdue_priority?: string
          sections?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      custom_agents: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          id: string
          last_run_at: string | null
          name: string
          owner_id: string
          run_count: number
          system_prompt: string
          tool_allowlist: string[]
          updated_at: string
          webhook_enabled: boolean
          webhook_secret: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          last_run_at?: string | null
          name: string
          owner_id: string
          run_count?: number
          system_prompt: string
          tool_allowlist?: string[]
          updated_at?: string
          webhook_enabled?: boolean
          webhook_secret?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          last_run_at?: string | null
          name?: string
          owner_id?: string
          run_count?: number
          system_prompt?: string
          tool_allowlist?: string[]
          updated_at?: string
          webhook_enabled?: boolean
          webhook_secret?: string
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
      digest_reply_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string
          digest_kind: string
          digest_ref: string | null
          expires_at: string
          id: string
          pending_action_ids: string[]
          project_ids: string[]
          token: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          digest_kind: string
          digest_ref?: string | null
          expires_at?: string
          id?: string
          pending_action_ids?: string[]
          project_ids?: string[]
          token: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          digest_kind?: string
          digest_ref?: string | null
          expires_at?: string
          id?: string
          pending_action_ids?: string[]
          project_ids?: string[]
          token?: string
          user_id?: string
        }
        Relationships: []
      }
      direct_messages: {
        Row: {
          body: string
          context_kind: string | null
          context_ref: string | null
          created_at: string
          id: string
          read_at: string | null
          recipient_id: string
          sender_id: string
          subject: string | null
        }
        Insert: {
          body: string
          context_kind?: string | null
          context_ref?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id: string
          sender_id: string
          subject?: string | null
        }
        Update: {
          body?: string
          context_kind?: string | null
          context_ref?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id?: string
          sender_id?: string
          subject?: string | null
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
      document_shares: {
        Row: {
          created_at: string
          created_by: string | null
          document_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_shares_document_id_fkey"
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
          visibility: Database["public"]["Enums"]["content_visibility"]
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
          visibility?: Database["public"]["Enums"]["content_visibility"]
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
          visibility?: Database["public"]["Enums"]["content_visibility"]
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
      eval_cases: {
        Row: {
          active: boolean
          created_at: string
          expected_substring: string | null
          expected_tool: string | null
          id: string
          name: string
          owner_id: string | null
          prompt: string
          tags: string[] | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          expected_substring?: string | null
          expected_tool?: string | null
          id?: string
          name: string
          owner_id?: string | null
          prompt: string
          tags?: string[] | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          expected_substring?: string | null
          expected_tool?: string | null
          id?: string
          name?: string
          owner_id?: string | null
          prompt?: string
          tags?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      eval_runs: {
        Row: {
          actor_id: string | null
          case_id: string
          created_at: string
          error: string | null
          id: string
          latency_ms: number | null
          output: string | null
          passed: boolean
          score: number | null
          tokens_in: number | null
          tokens_out: number | null
          tool_called: string | null
        }
        Insert: {
          actor_id?: string | null
          case_id: string
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          output?: string | null
          passed: boolean
          score?: number | null
          tokens_in?: number | null
          tokens_out?: number | null
          tool_called?: string | null
        }
        Update: {
          actor_id?: string | null
          case_id?: string
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          output?: string | null
          passed?: boolean
          score?: number | null
          tokens_in?: number | null
          tokens_out?: number | null
          tool_called?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eval_runs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "eval_cases"
            referencedColumns: ["id"]
          },
        ]
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
      inbound_email_events: {
        Row: {
          created_at: string
          error: string | null
          from_email: string
          id: string
          parsed_commands: Json
          provider_message_id: string | null
          raw_body: string | null
          results: Json
          status: string
          subject: string | null
          token: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          from_email: string
          id?: string
          parsed_commands?: Json
          provider_message_id?: string | null
          raw_body?: string | null
          results?: Json
          status?: string
          subject?: string | null
          token?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          from_email?: string
          id?: string
          parsed_commands?: Json
          provider_message_id?: string | null
          raw_body?: string | null
          results?: Json
          status?: string
          subject?: string | null
          token?: string | null
        }
        Relationships: []
      }
      integration_health: {
        Row: {
          checked_at: string
          error: string | null
          id: string
          latency_ms: number | null
          meta: Json | null
          name: string
          status: string
        }
        Insert: {
          checked_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          meta?: Json | null
          name: string
          status: string
        }
        Update: {
          checked_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          meta?: Json | null
          name?: string
          status?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          active_env: string | null
          api_key: string
          base_url: string
          environments: Json
          key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          active_env?: string | null
          api_key?: string
          base_url?: string
          environments?: Json
          key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          active_env?: string | null
          api_key?: string
          base_url?: string
          environments?: Json
          key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      notebook_messages: {
        Row: {
          citations: Json
          content: string
          created_at: string
          generated_by: string | null
          id: string
          role: string
          token: string
        }
        Insert: {
          citations?: Json
          content?: string
          created_at?: string
          generated_by?: string | null
          id?: string
          role: string
          token: string
        }
        Update: {
          citations?: Json
          content?: string
          created_at?: string
          generated_by?: string | null
          id?: string
          role?: string
          token?: string
        }
        Relationships: []
      }
      notebook_sources: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          label: string
          row_count: number | null
          summary: string | null
          summary_generated_at: string | null
          token: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          row_count?: number | null
          summary?: string | null
          summary_generated_at?: string | null
          token: string
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          row_count?: number | null
          summary?: string | null
          summary_generated_at?: string | null
          token?: string
          type?: string
          updated_at?: string
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
      pending_actions: {
        Row: {
          assigned_to: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          escalation_count: number
          escalation_tier: number
          executed_at: string | null
          execution_error: string | null
          id: string
          kind: string
          last_escalated_at: string | null
          payload: Json
          proposed_by: string | null
          rationale: string | null
          run_id: string | null
          status: string
          summary: string
          title: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          escalation_count?: number
          escalation_tier?: number
          executed_at?: string | null
          execution_error?: string | null
          id?: string
          kind: string
          last_escalated_at?: string | null
          payload: Json
          proposed_by?: string | null
          rationale?: string | null
          run_id?: string | null
          status?: string
          summary: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          escalation_count?: number
          escalation_tier?: number
          executed_at?: string | null
          execution_error?: string | null
          id?: string
          kind?: string
          last_escalated_at?: string | null
          payload?: Json
          proposed_by?: string | null
          rationale?: string | null
          run_id?: string | null
          status?: string
          summary?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_actions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
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
          degraded_until: string | null
          display_name: string
          id: string
          last_error: string | null
          last_refreshed_at: string | null
          last_row_hash_sample: string | null
          row_count: number
          sheet_type: Database["public"]["Enums"]["sheet_type"]
          source_url: string | null
          updated_at: string
          user_id: string
          visibility: Database["public"]["Enums"]["content_visibility"]
        }
        Insert: {
          apps_script_url: string
          created_at?: string
          degraded_until?: string | null
          display_name: string
          id?: string
          last_error?: string | null
          last_refreshed_at?: string | null
          last_row_hash_sample?: string | null
          row_count?: number
          sheet_type: Database["public"]["Enums"]["sheet_type"]
          source_url?: string | null
          updated_at?: string
          user_id: string
          visibility?: Database["public"]["Enums"]["content_visibility"]
        }
        Update: {
          apps_script_url?: string
          created_at?: string
          degraded_until?: string | null
          display_name?: string
          id?: string
          last_error?: string | null
          last_refreshed_at?: string | null
          last_row_hash_sample?: string | null
          row_count?: number
          sheet_type?: Database["public"]["Enums"]["sheet_type"]
          source_url?: string | null
          updated_at?: string
          user_id?: string
          visibility?: Database["public"]["Enums"]["content_visibility"]
        }
        Relationships: []
      }
      sheet_registry_shares: {
        Row: {
          created_at: string
          created_by: string | null
          sheet_registry_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          sheet_registry_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          sheet_registry_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sheet_registry_shares_sheet_registry_id_fkey"
            columns: ["sheet_registry_id"]
            isOneToOne: false
            referencedRelation: "sheet_registry"
            referencedColumns: ["id"]
          },
        ]
      }
      sheet_row_embeddings: {
        Row: {
          content_hash: string
          content_snippet: string
          created_at: string
          embedding: string
          id: string
          row_index: number
          sheet_registry_id: string
        }
        Insert: {
          content_hash: string
          content_snippet: string
          created_at?: string
          embedding: string
          id?: string
          row_index: number
          sheet_registry_id: string
        }
        Update: {
          content_hash?: string
          content_snippet?: string
          created_at?: string
          embedding?: string
          id?: string
          row_index?: number
          sheet_registry_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sheet_row_embeddings_sheet_registry_id_fkey"
            columns: ["sheet_registry_id"]
            isOneToOne: false
            referencedRelation: "sheet_registry"
            referencedColumns: ["id"]
          },
        ]
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
      sheet_sync_audit: {
        Row: {
          actor_id: string | null
          changed_columns: string[] | null
          changed_row_indexes: number[] | null
          created_at: string
          embed_embedded: number | null
          embed_ms: number | null
          embed_refreshed: number | null
          embed_remaining: number | null
          error: string | null
          fetch_ms: number | null
          fetched_at: string
          id: string
          project_id: string
          project_label: string | null
          rows_added: number | null
          rows_changed: number | null
          rows_removed: number | null
          rows_total: number | null
          sheet_url: string
          tab_name: string | null
          trigger_kind: string
          warning: string | null
        }
        Insert: {
          actor_id?: string | null
          changed_columns?: string[] | null
          changed_row_indexes?: number[] | null
          created_at?: string
          embed_embedded?: number | null
          embed_ms?: number | null
          embed_refreshed?: number | null
          embed_remaining?: number | null
          error?: string | null
          fetch_ms?: number | null
          fetched_at?: string
          id?: string
          project_id: string
          project_label?: string | null
          rows_added?: number | null
          rows_changed?: number | null
          rows_removed?: number | null
          rows_total?: number | null
          sheet_url: string
          tab_name?: string | null
          trigger_kind?: string
          warning?: string | null
        }
        Update: {
          actor_id?: string | null
          changed_columns?: string[] | null
          changed_row_indexes?: number[] | null
          created_at?: string
          embed_embedded?: number | null
          embed_ms?: number | null
          embed_refreshed?: number | null
          embed_remaining?: number | null
          error?: string | null
          fetch_ms?: number | null
          fetched_at?: string
          id?: string
          project_id?: string
          project_label?: string | null
          rows_added?: number | null
          rows_changed?: number | null
          rows_removed?: number | null
          rows_total?: number | null
          sheet_url?: string
          tab_name?: string | null
          trigger_kind?: string
          warning?: string | null
        }
        Relationships: []
      }
      signup_allowlist: {
        Row: {
          added_by: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          note: string | null
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          note?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          note?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Relationships: []
      }
      signup_notifications: {
        Row: {
          channel: string
          created_at: string
          id: string
          note: string | null
          request_id: string
          sent_by: string | null
        }
        Insert: {
          channel: string
          created_at?: string
          id?: string
          note?: string | null
          request_id: string
          sent_by?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          note?: string | null
          request_id?: string
          sent_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signup_notifications_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "signup_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      signup_requests: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          granted_role: Database["public"]["Enums"]["app_role"] | null
          id: string
          last_notified_at: string | null
          notify_count: number
          reject_reason: string | null
          requested_role: Database["public"]["Enums"]["app_role"]
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string
          verified_via: string | null
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          granted_role?: Database["public"]["Enums"]["app_role"] | null
          id?: string
          last_notified_at?: string | null
          notify_count?: number
          reject_reason?: string | null
          requested_role?: Database["public"]["Enums"]["app_role"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id: string
          verified_via?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          granted_role?: Database["public"]["Enums"]["app_role"] | null
          id?: string
          last_notified_at?: string | null
          notify_count?: number
          reject_reason?: string | null
          requested_role?: Database["public"]["Enums"]["app_role"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string
          verified_via?: string | null
        }
        Relationships: []
      }
      smart_alert_rules: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          kind: string
          phrase: string
          target: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          phrase: string
          target?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          phrase?: string
          target?: string
          updated_at?: string
        }
        Relationships: []
      }
      smart_alert_state: {
        Row: {
          id: string
          last_raised_at: string
          ref_key: string
          rule_kind: string
        }
        Insert: {
          id?: string
          last_raised_at?: string
          ref_key: string
          rule_kind: string
        }
        Update: {
          id?: string
          last_raised_at?: string
          ref_key?: string
          rule_kind?: string
        }
        Relationships: []
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
      user_project_assignments: {
        Row: {
          created_at: string
          id: string
          is_leader: boolean
          project_key: string
          project_label: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_leader?: boolean
          project_key: string
          project_label: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_leader?: boolean
          project_key?: string
          project_label?: string
          user_id?: string
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
      webhook_events: {
        Row: {
          agent_id: string
          created_at: string
          error: string | null
          id: string
          latency_ms: number | null
          output: string | null
          payload: Json | null
          run_id: string | null
          source_ip: string | null
          status: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          output?: string | null
          payload?: Json | null
          run_id?: string | null
          source_ip?: string | null
          status: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          output?: string | null
          payload?: Json | null
          run_id?: string | null
          source_ip?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "custom_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_briefings: {
        Row: {
          content_json: Json
          content_markdown: string
          created_at: string
          id: string
          scope: string
          user_id: string | null
          week_end: string
          week_start: string
        }
        Insert: {
          content_json?: Json
          content_markdown?: string
          created_at?: string
          id?: string
          scope: string
          user_id?: string | null
          week_end: string
          week_start: string
        }
        Update: {
          content_json?: Json
          content_markdown?: string
          created_at?: string
          id?: string
          scope?: string
          user_id?: string | null
          week_end?: string
          week_start?: string
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
      approve_signup: {
        Args: {
          _request_id: string
          _role: Database["public"]["Enums"]["app_role"]
        }
        Returns: undefined
      }
      can_read_document: {
        Args: {
          _doc_id: string
          _owner_id: string
          _user_id: string
          _visibility: Database["public"]["Enums"]["content_visibility"]
        }
        Returns: boolean
      }
      can_read_sheet: {
        Args: {
          _owner_id: string
          _registry_id: string
          _user_id: string
          _visibility: Database["public"]["Enums"]["content_visibility"]
        }
        Returns: boolean
      }
      can_see_project: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      delete_doc_folder: { Args: { _folder_id: string }; Returns: undefined }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      find_cross_sheet_rows: {
        Args: { _limit?: number; _needle: string; _user_id: string }
        Returns: {
          activity: string
          matched_on: string
          owner: string
          row_index: number
          sheet_name: string
          sheet_registry_id: string
          status: string
        }[]
      }
      find_cross_task_links: {
        Args: { _activity_id: string; _limit?: number; _user_id: string }
        Returns: {
          assignee_id: string
          assignee_name: string
          id: string
          project_id: string
          project_name: string
          relation: string
          status: Database["public"]["Enums"]["activity_status"]
          title: string
        }[]
      }
      find_person_footprint: {
        Args: { _limit?: number; _person_id: string; _user_id: string }
        Returns: {
          activity_count: number
          blocked_count: number
          latest_activity: string
          overdue_count: number
          project_id: string
          project_name: string
        }[]
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
      list_super_admin_emails: {
        Args: never
        Returns: {
          email: string
          full_name: string
          user_id: string
        }[]
      }
      match_all_sheet_rows: {
        Args: { _match_count?: number; _query: string; _user_id: string }
        Returns: {
          row_index: number
          sheet_name: string
          sheet_registry_id: string
          similarity: number
          snippet: string
        }[]
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
      match_sheet_rows: {
        Args: {
          _match_count?: number
          _query: string
          _registry_id: string
          _user_id: string
        }
        Returns: {
          row_index: number
          similarity: number
          snippet: string
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
      pgrst_reload: { Args: never; Returns: undefined }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      reject_signup: {
        Args: { _reason: string; _request_id: string }
        Returns: undefined
      }
      resend_signup_verification: {
        Args: { _note?: string; _request_id: string }
        Returns: undefined
      }
      seed_default_doc_folders: {
        Args: { _user_id: string }
        Returns: undefined
      }
      self_verify_signup: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: undefined
      }
      set_my_project_assignments: {
        Args: { _keys: string[]; _labels: string[] }
        Returns: undefined
      }
      verify_signup_from_allowlist: {
        Args: never
        Returns: {
          granted_role: Database["public"]["Enums"]["app_role"]
          reason: string
          verified: boolean
        }[]
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
      content_visibility: "private" | "public" | "shared"
      document_status: "pending" | "processing" | "ready" | "failed"
      sheet_type:
        | "progress"
        | "material_reconciliation"
        | "procurement"
        | "contractor_billing"
        | "bill_tracking"
        | "pms"
        | "tat"
        | "generic"
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
      content_visibility: ["private", "public", "shared"],
      document_status: ["pending", "processing", "ready", "failed"],
      sheet_type: [
        "progress",
        "material_reconciliation",
        "procurement",
        "contractor_billing",
        "bill_tracking",
        "pms",
        "tat",
        "generic",
      ],
    },
  },
} as const
