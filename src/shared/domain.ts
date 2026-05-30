export type AppRole = "student" | "teacher" | "admin";

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  role: AppRole;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}
