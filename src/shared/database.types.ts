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
export type ClassInviteRedeemStatus = "joined" | "already_member";

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
    };
    Enums: {
      app_user_role: AppRole;
      class_member_role: ClassMemberRole;
      github_auth_method: GithubAuthMethod;
      github_ssh_status: GithubSshStatus;
      thread_status: ThreadStatus;
      thread_priority: ThreadPriority;
    };
    CompositeTypes: Record<string, never>;
  };
}
