import type { AppRole } from "./domain";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ClassMemberRole = "student" | "teacher" | "mentor";
export type GithubAuthMethod = "gh_cli" | "device_flow" | "oauth" | "pat";
export type GithubSshStatus = "unknown" | "ok" | "failed";
export type ThreadStatus =
  | "open"
  | "in_progress"
  | "waiting_student"
  | "patch_proposed"
  | "resolved"
  | "reopened";
export type ThreadPriority = "low" | "normal" | "high";
export type MessageSenderType = "student" | "teacher" | "ai" | "system";
export type MessageType = "text" | "code" | "patch" | "environment" | "ai_summary";
export type ClassInviteRedeemStatus = "joined" | "already_member";
export type AuditEventType =
  | "auth_login_succeeded"
  | "auth_login_failed"
  | "auth_signup_succeeded"
  | "auth_signout_requested"
  | "class_created"
  | "class_invite_created"
  | "class_invite_redeemed"
  | "project_created"
  | "thread_created"
  | "message_sent"
  | "ai_used"
  | "patch_proposed"
  | "patch_applied"
  | "patch_failed"
  | "patch_reverted"
  | "patch_dismissed"
  | "ipc_operation"
  | "security_blocked";
export type AuditDecision = "allowed" | "denied" | "blocked" | "failed" | "succeeded";

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          display_name: string;
          role: AppRole;
          github_username: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name: string;
          role?: AppRole;
          github_username?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          email?: string;
          display_name?: string;
          role?: AppRole;
          github_username?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      classes: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          description: string | null;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          description?: string | null;
          created_by: string;
          created_at?: string;
        };
        Update: {
          organization_id?: string;
          name?: string;
          description?: string | null;
          created_by?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      class_members: {
        Row: {
          id: string;
          class_id: string;
          user_id: string;
          role: ClassMemberRole;
          joined_at: string;
        };
        Insert: {
          id?: string;
          class_id: string;
          user_id: string;
          role: ClassMemberRole;
          joined_at?: string;
        };
        Update: {
          class_id?: string;
          user_id?: string;
          role?: ClassMemberRole;
          joined_at?: string;
        };
        Relationships: [];
      };
      class_invites: {
        Row: {
          id: string;
          class_id: string;
          token: string;
          role: "student";
          expires_at: string;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          class_id: string;
          token: string;
          role?: "student";
          expires_at: string;
          created_by: string;
          created_at?: string;
        };
        Update: {
          class_id?: string;
          token?: string;
          role?: "student";
          expires_at?: string;
          created_by?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      github_connections: {
        Row: {
          id: string;
          user_id: string;
          github_username: string;
          auth_method: GithubAuthMethod;
          ssh_status: GithubSshStatus;
          last_checked_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          github_username: string;
          auth_method: GithubAuthMethod;
          ssh_status?: GithubSshStatus;
          last_checked_at?: string | null;
        };
        Update: {
          user_id?: string;
          github_username?: string;
          auth_method?: GithubAuthMethod;
          ssh_status?: GithubSshStatus;
          last_checked_at?: string | null;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          owner_user_id: string;
          class_id: string;
          name: string;
          local_path_hash: string | null;
          github_repo_url: string;
          default_branch: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_user_id: string;
          class_id: string;
          name: string;
          local_path_hash?: string | null;
          github_repo_url: string;
          default_branch?: string | null;
          created_at?: string;
        };
        Update: {
          owner_user_id?: string;
          class_id?: string;
          name?: string;
          local_path_hash?: string | null;
          github_repo_url?: string;
          default_branch?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      threads: {
        Row: {
          id: string;
          project_id: string;
          created_by: string;
          title: string;
          status: ThreadStatus;
          priority: ThreadPriority | null;
          ai_used: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          created_by: string;
          title: string;
          status?: ThreadStatus;
          priority?: ThreadPriority | null;
          ai_used?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          project_id?: string;
          created_by?: string;
          title?: string;
          status?: ThreadStatus;
          priority?: ThreadPriority | null;
          ai_used?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          thread_id: string;
          sender_user_id: string | null;
          sender_type: MessageSenderType;
          body: string;
          message_type: MessageType;
          reply_to_message_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          thread_id: string;
          sender_user_id?: string | null;
          sender_type: MessageSenderType;
          body: string;
          message_type?: MessageType;
          reply_to_message_id?: string | null;
          created_at?: string;
        };
        Update: {
          thread_id?: string;
          sender_user_id?: string | null;
          sender_type?: MessageSenderType;
          body?: string;
          message_type?: MessageType;
          reply_to_message_id?: string | null;
        };
        Relationships: [];
      };
      environment_snapshots: {
        Row: {
          id: string;
          thread_id: string;
          project_id: string;
          os_name: string | null;
          os_version: string | null;
          arch: string | null;
          git_version: string | null;
          editor_name: string | null;
          editor_version: string | null;
          runtimes: Json | null;
          package_managers: Json | null;
          dependencies_summary: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          thread_id: string;
          project_id: string;
          os_name?: string | null;
          os_version?: string | null;
          arch?: string | null;
          git_version?: string | null;
          editor_name?: string | null;
          editor_version?: string | null;
          runtimes?: Json | null;
          package_managers?: Json | null;
          dependencies_summary?: Json | null;
          created_at?: string;
        };
        Update: {
          thread_id?: string;
          project_id?: string;
          os_name?: string | null;
          os_version?: string | null;
          arch?: string | null;
          git_version?: string | null;
          editor_name?: string | null;
          editor_version?: string | null;
          runtimes?: Json | null;
          package_managers?: Json | null;
          dependencies_summary?: Json | null;
        };
        Relationships: [];
      };
      audit_events: {
        Row: {
          id: string;
          actor_user_id: string | null;
          actor_role: AppRole | null;
          event_type: AuditEventType;
          decision: AuditDecision;
          operation: string;
          class_id: string | null;
          project_id: string | null;
          thread_id: string | null;
          message_id: string | null;
          patch_proposal_id: string | null;
          ipc_channel: string | null;
          request_id: string | null;
          project_root_hash: string | null;
          relative_paths: string[];
          duration_ms: number | null;
          error_code: string | null;
          metadata: Json;
          redaction: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_user_id?: string | null;
          actor_role?: AppRole | null;
          event_type: AuditEventType;
          decision: AuditDecision;
          operation: string;
          class_id?: string | null;
          project_id?: string | null;
          thread_id?: string | null;
          message_id?: string | null;
          patch_proposal_id?: string | null;
          ipc_channel?: string | null;
          request_id?: string | null;
          project_root_hash?: string | null;
          relative_paths?: string[];
          duration_ms?: number | null;
          error_code?: string | null;
          metadata?: Json;
          redaction?: Json;
          created_at?: string;
        };
        Update: {
          actor_user_id?: string | null;
          actor_role?: AppRole | null;
          event_type?: AuditEventType;
          decision?: AuditDecision;
          operation?: string;
          class_id?: string | null;
          project_id?: string | null;
          thread_id?: string | null;
          message_id?: string | null;
          patch_proposal_id?: string | null;
          ipc_channel?: string | null;
          request_id?: string | null;
          project_root_hash?: string | null;
          relative_paths?: string[];
          duration_ms?: number | null;
          error_code?: string | null;
          metadata?: Json;
          redaction?: Json;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_class_invite: {
        Args: {
          p_class_id: string;
          p_role?: "student";
          p_expires_in_seconds?: number;
        };
        Returns: {
          token: string;
          class_id: string;
          role: "student";
          expires_at: string;
        }[];
      };
      redeem_class_invite: {
        Args: {
          p_token: string;
        };
        Returns: {
          class_id: string;
          role: "student";
          status: ClassInviteRedeemStatus;
        }[];
      };
      record_audit_event: {
        Args: {
          p_event_type: AuditEventType;
          p_decision: AuditDecision;
          p_operation: string;
          p_class_id?: string | null;
          p_project_id?: string | null;
          p_thread_id?: string | null;
          p_message_id?: string | null;
          p_patch_proposal_id?: string | null;
          p_ipc_channel?: string | null;
          p_request_id?: string | null;
          p_project_root_hash?: string | null;
          p_relative_paths?: string[];
          p_duration_ms?: number | null;
          p_error_code?: string | null;
          p_metadata?: Json;
          p_redaction?: Json;
        };
        Returns: string;
      };
    };
    Enums: {
      app_user_role: AppRole;
      class_member_role: ClassMemberRole;
      github_auth_method: GithubAuthMethod;
      github_ssh_status: GithubSshStatus;
      thread_status: ThreadStatus;
      thread_priority: ThreadPriority;
      message_sender_type: MessageSenderType;
      message_type: MessageType;
      audit_event_type: AuditEventType;
      audit_decision: AuditDecision;
    };
    CompositeTypes: Record<string, never>;
  };
}
