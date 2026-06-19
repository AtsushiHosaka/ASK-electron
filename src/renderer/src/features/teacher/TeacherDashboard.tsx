import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ClassMemberRole,
  Database,
  GithubSshStatus,
  Json,
  ThreadStatus
} from "../../../../shared/database.types";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";
import { trackUsageEvent } from "../../lib/telemetry";

type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
type ClassStudentRosterRow = Database["public"]["Tables"]["class_student_roster"]["Row"];
type GithubConnectionRow = Database["public"]["Tables"]["github_connections"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];
type StudentImportRpcRow =
  Database["public"]["Functions"]["import_class_students"]["Returns"][number];

interface MemberSummary {
  membership: ClassMemberRow;
  user: Pick<UserRow, "id" | "display_name" | "email" | "github_username" | "role"> | null;
  githubConnection: Pick<
    GithubConnectionRow,
    "user_id" | "github_username" | "ssh_status" | "last_checked_at"
  > | null;
}

interface ManagedClassSummary {
  classRow: ClassRow;
  myRole: ClassMemberRole;
  members: MemberSummary[];
  studentRoster: ClassStudentRosterRow[];
  projects: ProjectRow[];
  threads: ThreadRow[];
  statusCounts: Record<ThreadStatus, number>;
}

interface ClassJoinMemberSummary {
  membership: ClassMemberRow;
  user: Pick<UserRow, "id" | "display_name" | "github_username" | "role"> | null;
  isCurrentUser: boolean;
}

interface ClassJoinContext {
  classRow: Pick<ClassRow, "id" | "name" | "description" | "created_at">;
  joinedRole: ClassMemberRole;
  joinedStatus: string;
  members: ClassJoinMemberSummary[];
  projectCount: number;
}

interface TeacherDashboardState {
  loading: boolean;
  error: string | null;
  classes: ManagedClassSummary[];
}

type MessageStatus = "success" | "warning" | "error";
type StudentImportMode = "single" | "csv";

interface StudentImportDraft {
  displayName: string;
  email: string;
  githubUsername: string;
  lineNumber?: number;
}

interface StudentCsvParseResult {
  rows: StudentImportDraft[];
  errors: string[];
}

const threadStatuses: ThreadStatus[] = [
  "open",
  "in_progress",
  "waiting_student",
  "patch_proposed",
  "resolved",
  "reopened"
];

const statusLabels: Record<ThreadStatus, string> = {
  open: "未対応",
  in_progress: "対応中",
  waiting_student: "生徒確認待ち",
  patch_proposed: "パッチ提案中",
  resolved: "解決済み",
  reopened: "再オープン"
};

const sshStatusLabels: Record<GithubSshStatus, string> = {
  unknown: "未確認",
  ok: "SSH OK",
  failed: "SSH要確認"
};

const classMemberRoleLabels: Record<ClassMemberRole, string> = {
  student: "生徒",
  teacher: "講師",
  mentor: "メンター"
};

const initialStatusCounts = (): Record<ThreadStatus, number> =>
  Object.fromEntries(threadStatuses.map((status) => [status, 0])) as Record<ThreadStatus, number>;

const unique = (values: string[]): string[] => [...new Set(values)];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const normalizeGithubUsername = (value: string): string => value.trim().replace(/^@+/, "");

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (character === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current.trim());
  return cells;
};

const normalizeCsvHeader = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const headerIndex = (headers: string[], aliases: string[]): number => {
  const normalizedAliases = aliases.map(normalizeCsvHeader);
  return headers.findIndex((header) => normalizedAliases.includes(header));
};

const validateStudentDraft = (draft: StudentImportDraft): string[] => {
  const errors: string[] = [];

  if (!draft.displayName.trim()) {
    errors.push("名前を入力してください。");
  }

  if (!emailPattern.test(normalizeEmail(draft.email))) {
    errors.push("メールアドレスを確認してください。");
  }

  return errors;
};

const buildStudentDraft = (
  displayName: string,
  email: string,
  githubUsername: string,
  lineNumber?: number
): StudentImportDraft => ({
  displayName: displayName.trim(),
  email: normalizeEmail(email),
  githubUsername: normalizeGithubUsername(githubUsername),
  lineNumber
});

const parseStudentCsv = (source: string): StudentCsvParseResult => {
  const lines = source
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: [] };
  }

  const firstCells = parseCsvLine(lines[0].line);
  const normalizedHeaders = firstCells.map(normalizeCsvHeader);
  const emailColumn = headerIndex(normalizedHeaders, ["email", "mail", "メール"]);
  const nameColumn = headerIndex(normalizedHeaders, [
    "name",
    "displayname",
    "studentname",
    "名前",
    "氏名"
  ]);
  const githubColumn = headerIndex(normalizedHeaders, [
    "github",
    "githubusername",
    "githubuser",
    "githubユーザー名"
  ]);
  const hasHeader = emailColumn >= 0 && nameColumn >= 0;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows: StudentImportDraft[] = [];
  const errors: string[] = [];
  const seenEmails = new Set<string>();

  for (const { line, lineNumber } of dataLines) {
    const cells = parseCsvLine(line);
    const fallbackEmailFirst = cells[0]?.includes("@") ?? false;
    const draft = hasHeader
      ? buildStudentDraft(
          cells[nameColumn] ?? "",
          cells[emailColumn] ?? "",
          githubColumn >= 0 ? (cells[githubColumn] ?? "") : "",
          lineNumber
        )
      : buildStudentDraft(
          fallbackEmailFirst ? (cells[1] ?? "") : (cells[0] ?? ""),
          fallbackEmailFirst ? (cells[0] ?? "") : (cells[1] ?? ""),
          cells[2] ?? "",
          lineNumber
        );
    const rowErrors = validateStudentDraft(draft);

    if (seenEmails.has(draft.email)) {
      rowErrors.push("同じメールアドレスが重複しています。");
    }

    if (rowErrors.length > 0) {
      errors.push(`${lineNumber}行目: ${rowErrors.join(" ")}`);
      continue;
    }

    seenEmails.add(draft.email);
    rows.push(draft);
  }

  return { rows, errors };
};

const classJoinStatusLabel = (status: string): string =>
  status === "already_member" ? "参加済み" : "参加完了";

const classJoinMemberDisplayName = (member: ClassJoinMemberSummary): string => {
  if (member.isCurrentUser) {
    return member.user?.display_name ?? member.user?.github_username ?? "あなた";
  }

  return member.user?.display_name ?? member.user?.github_username ?? "名前未設定";
};

const classJoinMemberMeta = (member: ClassJoinMemberSummary): string => {
  const roleLabel = classMemberRoleLabels[member.membership.role];

  if (member.user?.github_username) {
    return `${roleLabel} / @${member.user.github_username}`;
  }

  return roleLabel;
};

const useTeacherDashboard = (reloadVersion = 0): TeacherDashboardState => {
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<TeacherDashboardState>({
    loading: true,
    error: null,
    classes: []
  });

  useEffect(() => {
    let mounted = true;

    const load = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。",
          classes: []
        });
        return;
      }

      setState((current) => ({ ...current, loading: true, error: null }));

      try {
        const { data: ownMemberships, error: membershipError } = await supabase
          .from("class_members")
          .select("id,class_id,user_id,role,joined_at")
          .eq("user_id", profile.id)
          .in("role", ["teacher", "mentor"]);

        if (membershipError) {
          throw membershipError;
        }

        const classIds = unique((ownMemberships ?? []).map((membership) => membership.class_id));

        if (classIds.length === 0) {
          if (mounted) {
            setState({ loading: false, error: null, classes: [] });
          }
          return;
        }

        const [classesResult, membersResult, projectsResult, rosterResult] = await Promise.all([
          supabase
            .from("classes")
            .select("id,organization_id,name,description,created_by,created_at")
            .in("id", classIds)
            .order("created_at", { ascending: false }),
          supabase
            .from("class_members")
            .select("id,class_id,user_id,role,joined_at")
            .in("class_id", classIds),
          supabase
            .from("projects")
            .select(
              "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
            )
            .in("class_id", classIds),
          supabase
            .from("class_student_roster")
            .select(
              "id,class_id,email,display_name,github_username,linked_user_id,added_by,created_at,updated_at"
            )
            .in("class_id", classIds)
        ]);

        if (
          classesResult.error ||
          membersResult.error ||
          projectsResult.error ||
          rosterResult.error
        ) {
          throw (
            classesResult.error ?? membersResult.error ?? projectsResult.error ?? rosterResult.error
          );
        }

        const members = membersResult.data ?? [];
        const projects = projectsResult.data ?? [];
        const roster = rosterResult.data ?? [];
        const userIds = unique(members.map((member) => member.user_id));
        const projectIds = projects.map((project) => project.id);

        const [usersResult, githubConnectionsResult, threadsResult] = await Promise.all([
          userIds.length > 0
            ? supabase
                .from("users")
                .select("id,email,display_name,role,github_username,created_at,updated_at")
                .in("id", userIds)
            : Promise.resolve({ data: [], error: null }),
          userIds.length > 0
            ? supabase
                .from("github_connections")
                .select("user_id,github_username,ssh_status,last_checked_at")
                .in("user_id", userIds)
            : Promise.resolve({ data: [], error: null }),
          projectIds.length > 0
            ? supabase
                .from("threads")
                .select(
                  "id,project_id,created_by,title,status,priority,ai_used,created_at,updated_at"
                )
                .in("project_id", projectIds)
                .order("updated_at", { ascending: false })
            : Promise.resolve({ data: [], error: null })
        ]);

        if (usersResult.error || githubConnectionsResult.error || threadsResult.error) {
          throw usersResult.error ?? githubConnectionsResult.error ?? threadsResult.error;
        }

        const usersById = new Map((usersResult.data ?? []).map((user) => [user.id, user]));
        const connectionsByUserId = new Map(
          (githubConnectionsResult.data ?? []).map((connection) => [connection.user_id, connection])
        );
        const projectsByClassId = new Map<string, ProjectRow[]>();
        const threadsByProjectId = new Map<string, ThreadRow[]>();
        const rosterByClassId = new Map<string, ClassStudentRosterRow[]>();

        for (const project of projects) {
          const classProjects = projectsByClassId.get(project.class_id) ?? [];
          classProjects.push(project);
          projectsByClassId.set(project.class_id, classProjects);
        }

        for (const rosterRow of roster) {
          const classRoster = rosterByClassId.get(rosterRow.class_id) ?? [];
          classRoster.push(rosterRow);
          rosterByClassId.set(rosterRow.class_id, classRoster);
        }

        for (const thread of threadsResult.data ?? []) {
          const projectThreads = threadsByProjectId.get(thread.project_id) ?? [];
          projectThreads.push(thread);
          threadsByProjectId.set(thread.project_id, projectThreads);
        }

        const managedClasses = (classesResult.data ?? []).map((classRow) => {
          const classMembers = members.filter((member) => member.class_id === classRow.id);
          const classProjects = projectsByClassId.get(classRow.id) ?? [];
          const classThreads = classProjects.flatMap(
            (project) => threadsByProjectId.get(project.id) ?? []
          );
          const statusCounts = initialStatusCounts();

          for (const thread of classThreads) {
            statusCounts[thread.status] += 1;
          }

          return {
            classRow,
            myRole:
              ownMemberships?.find((membership) => membership.class_id === classRow.id)?.role ??
              "teacher",
            members: classMembers.map((membership) => ({
              membership,
              user: usersById.get(membership.user_id) ?? null,
              githubConnection: connectionsByUserId.get(membership.user_id) ?? null
            })),
            studentRoster: rosterByClassId.get(classRow.id) ?? [],
            projects: classProjects,
            threads: classThreads,
            statusCounts
          } satisfies ManagedClassSummary;
        });

        if (mounted) {
          setState({ loading: false, error: null, classes: managedClasses });
        }
      } catch (error) {
        console.error("Failed to load teacher dashboard", error);

        if (mounted) {
          setState({
            loading: false,
            error: "担当クラスを読み込めませんでした。",
            classes: []
          });
        }
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [profile, reloadVersion, supabase]);

  return state;
};

export const TeacherHomePage = (): ReactElement => {
  const [reloadVersion, setReloadVersion] = useState(0);
  const [classCreateOpen, setClassCreateOpen] = useState(false);
  const { loading, error, classes } = useTeacherDashboard(reloadVersion);

  const reloadClasses = useCallback((): void => setReloadVersion((current) => current + 1), []);
  const openClassCreate = useCallback((): void => setClassCreateOpen(true), []);
  const closeClassCreate = useCallback((): void => setClassCreateOpen(false), []);

  if (loading) {
    return <TeacherPageState title="読み込み中" body="担当クラスを確認しています。" />;
  }

  if (error) {
    return <TeacherPageState title="読み込みに失敗しました" body={error} />;
  }

  if (classes.length === 0) {
    return (
      <section className="teacher-dashboard">
        <div className="page-header">
          <div>
            <p className="eyebrow">Teacher</p>
            <h1>担当クラス</h1>
          </div>
          <div className="teacher-header-actions">
            <button className="primary-button" type="button" onClick={openClassCreate}>
              クラスを作成
            </button>
            <div className="progress-summary">
              <strong>0 クラス</strong>
              <span>未作成</span>
            </div>
          </div>
        </div>

        <article className="detail-panel">
          <p className="muted">クラスがありません。</p>
        </article>

        <TeacherClassCreateModal
          open={classCreateOpen}
          onClose={closeClassCreate}
          onCreated={reloadClasses}
        />
      </section>
    );
  }

  return (
    <section className="teacher-dashboard">
      <div className="page-header">
        <div>
          <p className="eyebrow">Teacher</p>
          <h1>担当クラス</h1>
        </div>
        <div className="teacher-header-actions">
          <button className="primary-button" type="button" onClick={openClassCreate}>
            クラスを作成
          </button>
          <div className="progress-summary">
            <strong>{classes.length} クラス</strong>
            <span>担当中</span>
          </div>
        </div>
      </div>

      <div className="teacher-class-grid">
        {classes.map((classSummary) => (
          <article className="teacher-class-card" key={classSummary.classRow.id}>
            <div>
              <p className="eyebrow">{classSummary.myRole}</p>
              <h2>{classSummary.classRow.name}</h2>
              <p>{classSummary.classRow.description ?? "説明は未設定です。"}</p>
            </div>

            <StatusCounters statusCounts={classSummary.statusCounts} />

            <div className="teacher-card-footer">
              <span>{studentMembers(classSummary).length} students</span>
              <Link className="secondary-link" to={`/classes/${classSummary.classRow.id}`}>
                詳細を見る
              </Link>
            </div>
          </article>
        ))}
      </div>

      <TeacherClassCreateModal
        open={classCreateOpen}
        onClose={closeClassCreate}
        onCreated={reloadClasses}
      />
    </section>
  );
};

const TeacherClassCreateModal = ({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement | null => {
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const creatingRef = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<MessageStatus>("success");

  const canCreateClass = profile?.role === "teacher" || profile?.role === "admin";

  const closeDialog = useCallback((): void => {
    if (creatingRef.current) {
      return;
    }

    setName("");
    setDescription("");
    setMessage(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    creatingRef.current = creating;
  }, [creating]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modal = dialogRef.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    const getFocusableElements = (): HTMLElement[] =>
      Array.from(modal?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => !element.hasAttribute("disabled") && element.offsetParent !== null
      );

    window.requestAnimationFrame(() => {
      (nameInputRef.current ?? getFocusableElements()[0] ?? modal)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key !== "Tab" || !modal) {
        return;
      }

      const focusableElements = getFocusableElements();

      if (focusableElements.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements.at(-1);

      if (!firstFocusable || !lastFocusable) {
        return;
      }

      if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [closeDialog, open]);

  if (!open) {
    return null;
  }

  const createClass = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!supabase || !profile) {
      setMessageStatus("error");
      setMessage("Supabase 設定またはプロフィールを確認できませんでした。");
      return;
    }

    if (!canCreateClass) {
      setMessageStatus("warning");
      setMessage("先生または管理者アカウントのみクラスを作成できます。");
      return;
    }

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    if (!trimmedName) {
      setMessageStatus("warning");
      setMessage("クラス名を入力してください。");
      return;
    }

    setCreating(true);
    setMessage(null);

    try {
      const { error: createError } = await supabase.from("classes").insert({
        organization_id: profile.id,
        name: trimmedName,
        description: trimmedDescription || null,
        created_by: profile.id
      });

      if (createError) {
        setMessageStatus("error");
        setMessage(
          createError.code === "23505"
            ? "同じ名前のクラスが既にあります。"
            : "クラスを作成できませんでした。権限と入力内容を確認してください。"
        );
        return;
      }

      setName("");
      setDescription("");
      onCreated();
      onClose();
    } catch (error) {
      console.error("Failed to create class", error);
      setMessageStatus("error");
      setMessage("クラスを作成できませんでした。");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="class-create-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby="class-create-title"
        aria-modal="true"
        className="class-create-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id="class-create-title">クラスを作成</h2>
          <button
            className="secondary-button"
            disabled={creating}
            type="button"
            onClick={closeDialog}
          >
            閉じる
          </button>
        </header>

        <form className="class-create-form" onSubmit={(event) => void createClass(event)}>
          <label>
            クラス名
            <input
              ref={nameInputRef}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label>
            説明
            <textarea
              maxLength={240}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          {!canCreateClass && (
            <p className="message warning" role="status">
              先生または管理者アカウントのみクラスを作成できます。
            </p>
          )}

          {message && (
            <p
              className={`message ${messageStatus}`}
              role={messageStatus === "error" ? "alert" : "status"}
            >
              {message}
            </p>
          )}

          <footer>
            <button
              className="secondary-button"
              disabled={creating}
              type="button"
              onClick={closeDialog}
            >
              キャンセル
            </button>
            <button className="primary-button" disabled={creating || !canCreateClass} type="submit">
              {creating ? "作成中..." : "作成"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

const StudentAddModal = ({
  open,
  classId,
  onClose,
  onImported
}: {
  open: boolean;
  classId: string;
  onClose: () => void;
  onImported: (message: string) => void;
}): ReactElement | null => {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const csvTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const importingRef = useRef(false);
  const [mode, setMode] = useState<StudentImportMode>("single");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<MessageStatus>("success");
  const [rowResults, setRowResults] = useState<StudentImportRpcRow[]>([]);
  const csvParseResult = useMemo(() => parseStudentCsv(csvText), [csvText]);

  const closeDialog = useCallback((): void => {
    if (importingRef.current) {
      return;
    }

    setMode("single");
    setDisplayName("");
    setEmail("");
    setGithubUsername("");
    setCsvText("");
    setMessage(null);
    setRowResults([]);
    onClose();
  }, [onClose]);

  useEffect(() => {
    importingRef.current = importing;
  }, [importing]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modal = dialogRef.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    const getFocusableElements = (): HTMLElement[] =>
      Array.from(modal?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => !element.hasAttribute("disabled") && element.offsetParent !== null
      );

    window.requestAnimationFrame(() => {
      const primaryField = mode === "single" ? nameInputRef.current : csvTextAreaRef.current;
      (primaryField ?? getFocusableElements()[0] ?? modal)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key !== "Tab" || !modal) {
        return;
      }

      const focusableElements = getFocusableElements();

      if (focusableElements.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements.at(-1);

      if (!firstFocusable || !lastFocusable) {
        return;
      }

      if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      }

      if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [closeDialog, mode, open]);

  if (!open) {
    return null;
  }

  const importStudents = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!supabase) {
      setMessageStatus("error");
      setMessage("Supabase 設定を確認できませんでした。");
      return;
    }

    const singleDraft = buildStudentDraft(displayName, email, githubUsername);
    const singleErrors = validateStudentDraft(singleDraft);
    const drafts = mode === "single" ? [singleDraft] : csvParseResult.rows;
    const errors = mode === "single" ? singleErrors : csvParseResult.errors;

    if (mode === "csv" && csvText.trim().length === 0) {
      setMessageStatus("warning");
      setMessage("CSVを入力してください。");
      return;
    }

    if (errors.length > 0 || drafts.length === 0) {
      setMessageStatus("warning");
      setMessage(errors.length > 0 ? errors.join(" ") : "追加する生徒を入力してください。");
      return;
    }

    setImporting(true);
    setMessage(null);
    setRowResults([]);

    try {
      const payload = drafts.map((draft) => ({
        display_name: draft.displayName,
        email: draft.email,
        github_username: draft.githubUsername || null
      })) as Json;
      const { data, error: importError } = await supabase.rpc("import_class_students", {
        p_class_id: classId,
        p_students: payload
      });

      if (importError) {
        throw importError;
      }

      const results = data ?? [];
      const invalidRows = results.filter((result) => result.error);
      const memberCount = results.filter(
        (result) => result.status === "added_member" || result.status === "already_member"
      ).length;
      const pendingCount = results.filter((result) => result.status === "pending_signup").length;
      const summary = `追加 ${memberCount} / 未参加 ${pendingCount}`;

      setRowResults(results);

      if (invalidRows.length > 0) {
        setMessageStatus("warning");
        setMessage(invalidRows.map((result) => `${result.email}: ${result.error}`).join(" "));
        return;
      }

      onImported(summary);
      closeDialog();
    } catch (error) {
      console.error("Failed to import class students", error);
      setMessageStatus("error");
      setMessage("生徒を追加できませんでした。入力内容と権限を確認してください。");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      className="class-create-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby="student-add-title"
        aria-modal="true"
        className="class-create-dialog student-add-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id="student-add-title">生徒を追加</h2>
          <button
            className="secondary-button"
            disabled={importing}
            type="button"
            onClick={closeDialog}
          >
            閉じる
          </button>
        </header>

        <form className="class-create-form" onSubmit={(event) => void importStudents(event)}>
          <div className="student-add-tabs" role="tablist" aria-label="追加方法">
            <button
              aria-selected={mode === "single"}
              className={mode === "single" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setMode("single")}
            >
              1人
            </button>
            <button
              aria-selected={mode === "csv"}
              className={mode === "csv" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setMode("csv")}
            >
              CSV
            </button>
          </div>

          {mode === "single" ? (
            <div className="student-add-fields">
              <label>
                名前
                <input
                  ref={nameInputRef}
                  maxLength={80}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label>
                メール
                <input
                  inputMode="email"
                  maxLength={160}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                GitHub
                <input
                  maxLength={80}
                  value={githubUsername}
                  onChange={(event) => setGithubUsername(event.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="student-add-fields">
              <label>
                CSV
                <textarea
                  ref={csvTextAreaRef}
                  rows={8}
                  value={csvText}
                  placeholder="名前,email,github"
                  onChange={(event) => setCsvText(event.target.value)}
                />
              </label>

              {csvText.trim().length > 0 ? (
                <div className="student-add-preview" aria-live="polite">
                  <span>{csvParseResult.rows.length} 行</span>
                  {csvParseResult.errors.length > 0 ? (
                    <ul>
                      {csvParseResult.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {message && (
            <p
              className={`message ${messageStatus}`}
              role={messageStatus === "error" ? "alert" : "status"}
            >
              {message}
            </p>
          )}

          {rowResults.some((result) => result.error) ? (
            <div className="student-add-preview" role="status">
              <ul>
                {rowResults
                  .filter((result) => result.error)
                  .map((result) => (
                    <li key={`${result.email}-${result.error}`}>
                      {result.email}: {result.error}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          <footer>
            <button
              className="secondary-button"
              disabled={importing}
              type="button"
              onClick={closeDialog}
            >
              キャンセル
            </button>
            <button className="primary-button" disabled={importing} type="submit">
              {importing ? "追加中..." : "追加"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export const ClassDetailPage = (): ReactElement => {
  const { classId } = useParams();
  const [reloadVersion, setReloadVersion] = useState(0);
  const { loading, error, classes } = useTeacherDashboard(reloadVersion);
  const [studentAddOpen, setStudentAddOpen] = useState(false);
  const [studentAddMessage, setStudentAddMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!studentAddMessage) {
      return;
    }

    const timerId = window.setTimeout(() => setStudentAddMessage(null), 2500);

    return () => window.clearTimeout(timerId);
  }, [studentAddMessage]);

  if (loading) {
    return <TeacherPageState title="読み込み中" body="クラス詳細を確認しています。" />;
  }

  if (error) {
    return <TeacherPageState title="読み込みに失敗しました" body={error} />;
  }

  const classSummary = classes.find((summary) => summary.classRow.id === classId) ?? null;

  if (!classSummary) {
    return (
      <TeacherPageState
        title="クラスが見つかりません"
        body="担当外のクラス、または存在しないクラスは表示できません。"
      />
    );
  }

  const projectThreadGroups = classSummary.projects.map((project) => ({
    project,
    threads: classSummary.threads.filter((thread) => thread.project_id === project.id)
  }));
  const openStudentAdd = (): void => setStudentAddOpen(true);
  const closeStudentAdd = (): void => setStudentAddOpen(false);
  const handleStudentImported = (message: string): void => {
    setStudentAddMessage(message);
    setReloadVersion((current) => current + 1);
  };

  return (
    <section className="teacher-dashboard">
      <div className="page-header">
        <div>
          <nav className="breadcrumb" aria-label="パンくずリスト">
            <Link to="/classes">クラス</Link>
            <span>{classSummary.classRow.name}</span>
          </nav>
          <h1>{classSummary.classRow.name}</h1>
          <p className="muted">{classSummary.classRow.description ?? "説明は未設定です。"}</p>
        </div>
        <div className="class-detail-actions">
          <StatusCounters statusCounts={classSummary.statusCounts} compact />
          <button className="primary-button" type="button" onClick={openStudentAdd}>
            生徒を追加
          </button>
        </div>
      </div>

      {studentAddMessage ? (
        <p className="message success" role="status">
          {studentAddMessage}
        </p>
      ) : null}

      <div className="detail-grid">
        <StudentMemberPanel classSummary={classSummary} />
        <MemberPanel title="講師 / メンター" members={mentorMembers(classSummary)} />

        <article className="detail-panel class-project-thread-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Projects</p>
              <h2>プロジェクト</h2>
            </div>
            <span className="status-pill pending">{projectThreadGroups.length} 件</span>
          </div>

          {projectThreadGroups.length === 0 ? (
            <p className="muted">このクラスのプロジェクトはまだありません。</p>
          ) : (
            <div className="class-project-thread-list">
              {projectThreadGroups.map(({ project, threads }) => (
                <section className="class-project-thread-card" key={project.id}>
                  <div className="class-project-thread-card-header">
                    <div>
                      <h3>{project.name}</h3>
                      <span>{threads.length} 件の質問</span>
                    </div>
                    <Link className="secondary-link" to={`/projects/${project.id}`}>
                      詳細
                    </Link>
                  </div>

                  {threads.length === 0 ? (
                    <p className="muted compact">このプロジェクトの質問はまだありません。</p>
                  ) : (
                    <div className="teacher-thread-list">
                      {threads.map((thread) => (
                        <Link
                          className="teacher-thread-row"
                          key={thread.id}
                          to={`/projects/${project.id}/threads/${thread.id}`}
                        >
                          <span>{thread.title}</span>
                          <span>{statusLabels[thread.status]}</span>
                          <span>{new Date(thread.updated_at).toLocaleDateString()}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </article>
      </div>

      <StudentAddModal
        open={studentAddOpen}
        classId={classSummary.classRow.id}
        onClose={closeStudentAdd}
        onImported={handleStudentImported}
      />
    </section>
  );
};

export const ClassJoinPage = (): ReactElement => {
  const { token } = useParams();
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [joinState, setJoinState] = useState<{
    loading: boolean;
    message: string;
    error: string | null;
    classContext: ClassJoinContext | null;
    contextWarning: string | null;
  }>({
    loading: true,
    message: "招待を確認しています。",
    error: null,
    classContext: null,
    contextWarning: null
  });

  useEffect(() => {
    let mounted = true;

    const redeemInvite = async (): Promise<void> => {
      if (!token) {
        setJoinState({
          loading: false,
          message: "",
          error: "招待トークンが見つかりません。",
          classContext: null,
          contextWarning: null
        });
        return;
      }

      if (!supabase) {
        setJoinState({
          loading: false,
          message: "",
          error: "Supabase 設定を確認できませんでした。",
          classContext: null,
          contextWarning: null
        });
        return;
      }

      try {
        const { data, error: redeemError } = await supabase.rpc("redeem_class_invite", {
          p_token: token
        });

        if (redeemError) {
          throw redeemError;
        }

        const result = data?.[0];

        if (!result) {
          throw new Error("CLASS_INVITE_REDEEM_RESULT_MISSING");
        }

        let classContext: ClassJoinContext | null = null;
        let contextWarning: string | null = null;

        try {
          const { data: classRow, error: classError } = await supabase
            .from("classes")
            .select("id,name,description,created_at")
            .eq("id", result.class_id)
            .maybeSingle();

          if (classError || !classRow) {
            throw classError ?? new Error("JOINED_CLASS_CONTEXT_MISSING");
          }

          const { data: memberships, error: membershipsError } = await supabase
            .from("class_members")
            .select("id,class_id,user_id,role,joined_at")
            .eq("class_id", result.class_id)
            .order("joined_at", { ascending: true });

          if (membershipsError) {
            throw membershipsError;
          }

          const userIds = unique((memberships ?? []).map((membership) => membership.user_id));
          let users: Pick<UserRow, "id" | "display_name" | "github_username" | "role">[] = [];

          if (userIds.length > 0) {
            const { data: usersData, error: usersError } = await supabase
              .from("users")
              .select("id,display_name,github_username,role")
              .in("id", userIds);

            if (usersError) {
              throw usersError;
            }

            users = usersData ?? [];
          }

          let projectCount = 0;

          if (profile?.id) {
            const { data: projects, error: projectsError } = await supabase
              .from("projects")
              .select("id")
              .eq("class_id", result.class_id)
              .eq("owner_user_id", profile.id);

            if (projectsError) {
              throw projectsError;
            }

            projectCount = projects?.length ?? 0;
          }

          const usersById = new Map(users.map((user) => [user.id, user]));

          classContext = {
            classRow,
            joinedRole: result.role,
            joinedStatus: result.status,
            members: (memberships ?? []).map((membership) => ({
              membership,
              user: usersById.get(membership.user_id) ?? null,
              isCurrentUser: membership.user_id === profile?.id
            })),
            projectCount
          };
        } catch (contextError) {
          console.error("Failed to load joined class context", contextError);
          contextWarning = "クラス情報を読み込めませんでした。ホームから確認してください。";
        }

        if (mounted) {
          setJoinState({
            loading: false,
            message:
              result.status === "already_member"
                ? "すでにこのクラスに参加しています。"
                : "クラスに参加しました。",
            error: null,
            classContext,
            contextWarning
          });
        }
        void trackUsageEvent({
          eventName: "class_joined",
          classId: result.class_id,
          success: true,
          properties: {
            status: result.status,
            role: result.role
          }
        });
      } catch (error) {
        console.error("Failed to redeem class invite", error);

        if (mounted) {
          setJoinState({
            loading: false,
            message: "",
            error: "招待を受け付けできませんでした。期限切れまたは権限不足の可能性があります。",
            classContext: null,
            contextWarning: null
          });
        }
      }
    };

    void redeemInvite();

    return () => {
      mounted = false;
    };
  }, [profile?.id, supabase, token]);

  if (joinState.loading) {
    return <TeacherPageState title="招待を確認中" body={joinState.message} />;
  }

  if (joinState.error) {
    return <TeacherPageState title="クラスに参加できません" body={joinState.error} />;
  }

  if (!joinState.classContext) {
    return (
      <section className="empty-state">
        <h1>クラス参加が完了しました</h1>
        <p>{joinState.message}</p>
        {joinState.contextWarning ? (
          <p className="message warning" role="status">
            {joinState.contextWarning}
          </p>
        ) : null}
        <Link className="secondary-link" to="/student">
          ホームへ戻る
        </Link>
      </section>
    );
  }

  const classContext = joinState.classContext;
  const studentMembers = classContext.members.filter(
    (member) => member.membership.role === "student"
  );
  const staffMembers = classContext.members.filter(
    (member) => member.membership.role !== "student"
  );
  const classmates = studentMembers.filter((member) => !member.isCurrentUser);
  const visibleClassmates = classmates.slice(0, 6);
  const hiddenClassmateCount = Math.max(0, classmates.length - visibleClassmates.length);
  const primaryProjectAction =
    classContext.projectCount > 0 ? "プロジェクトを見る" : "プロジェクトを登録";

  return (
    <section className="class-join-confirmation">
      <article className="detail-panel class-join-hero">
        <div>
          <span className="status-pill success">
            {classJoinStatusLabel(classContext.joinedStatus)}
          </span>
          <h1>{classContext.classRow.name}</h1>
          <p>{classContext.classRow.description ?? joinState.message}</p>
        </div>
        <div className="class-join-actions">
          <Link className="primary-button" to="/projects">
            {primaryProjectAction}
          </Link>
          <Link className="secondary-link" to="/student">
            ホーム
          </Link>
        </div>
      </article>

      <div className="class-join-grid">
        <article className="detail-panel class-join-summary-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Class</p>
              <h2>クラス概要</h2>
            </div>
          </div>
          <div className="class-join-metrics" aria-label="クラス概要">
            <div>
              <span>生徒</span>
              <strong>{studentMembers.length}</strong>
            </div>
            <div>
              <span>先生</span>
              <strong>{staffMembers.length}</strong>
            </div>
            <div>
              <span>自分のプロジェクト</span>
              <strong>{classContext.projectCount}</strong>
            </div>
          </div>
          <dl className="class-join-detail-list">
            <div>
              <dt>あなたの役割</dt>
              <dd>{classMemberRoleLabels[classContext.joinedRole]}</dd>
            </div>
            <div>
              <dt>作成日</dt>
              <dd>{new Date(classContext.classRow.created_at).toLocaleDateString()}</dd>
            </div>
          </dl>
        </article>

        <ClassJoinMembersPanel
          title="先生 / メンター"
          emptyText="担当者はまだ表示できません。"
          members={staffMembers}
        />

        <ClassJoinMembersPanel
          title="ほかの生徒"
          emptyText="ほかの生徒はまだ表示できません。"
          extraCount={hiddenClassmateCount}
          members={visibleClassmates}
        />
      </div>

      {joinState.contextWarning ? (
        <p className="message warning" role="status">
          {joinState.contextWarning}
        </p>
      ) : null}
    </section>
  );
};

const ClassJoinMembersPanel = ({
  title,
  members,
  emptyText,
  extraCount = 0
}: {
  title: string;
  members: ClassJoinMemberSummary[];
  emptyText: string;
  extraCount?: number;
}): ReactElement => (
  <article className="detail-panel class-join-member-panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Members</p>
        <h2>{title}</h2>
      </div>
      <span className="status-pill pending">{members.length + extraCount} 人</span>
    </div>

    {members.length === 0 ? (
      <p className="muted">{emptyText}</p>
    ) : (
      <div className="class-join-member-list">
        {members.map((member) => (
          <div className="class-join-member-row" key={member.membership.id}>
            <div>
              <strong>{classJoinMemberDisplayName(member)}</strong>
              <span>{classJoinMemberMeta(member)}</span>
            </div>
            {member.isCurrentUser ? <span className="status-pill success">自分</span> : null}
          </div>
        ))}
        {extraCount > 0 ? <p className="muted compact">ほか {extraCount} 人</p> : null}
      </div>
    )}
  </article>
);

const studentMembers = (classSummary: ManagedClassSummary): MemberSummary[] =>
  classSummary.members.filter((member) => member.membership.role === "student");

const mentorMembers = (classSummary: ManagedClassSummary): MemberSummary[] =>
  classSummary.members.filter((member) => member.membership.role !== "student");

const pendingStudentRoster = (classSummary: ManagedClassSummary): ClassStudentRosterRow[] => {
  const students = studentMembers(classSummary);
  const studentUserIds = new Set(students.map((member) => member.membership.user_id));
  const studentEmails = new Set(
    students.map((member) => normalizeEmail(member.user?.email ?? "")).filter(Boolean)
  );

  return classSummary.studentRoster.filter((rosterRow) => {
    const linkedUserIsMember =
      rosterRow.linked_user_id !== null && studentUserIds.has(rosterRow.linked_user_id);
    const emailIsMember = studentEmails.has(normalizeEmail(rosterRow.email));

    return !linkedUserIsMember && !emailIsMember;
  });
};

const StudentMemberPanel = ({
  classSummary
}: {
  classSummary: ManagedClassSummary;
}): ReactElement => {
  const students = studentMembers(classSummary);
  const pendingStudents = pendingStudentRoster(classSummary);
  const totalCount = students.length + pendingStudents.length;

  return (
    <article className="detail-panel member-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Members</p>
          <h2>生徒</h2>
        </div>
        <span className="status-pill pending">{totalCount} 人</span>
      </div>

      {totalCount === 0 ? (
        <p className="muted">まだ生徒がいません。</p>
      ) : (
        <div className="member-list">
          {students.map((member) => {
            const githubUsername =
              member.githubConnection?.github_username ?? member.user?.github_username ?? null;

            return (
              <div className="member-row" key={member.membership.id}>
                <div>
                  <strong>{member.user?.display_name ?? "名前未設定"}</strong>
                  <span>{member.user?.email ?? "メール未取得"}</span>
                </div>
                <div className="member-setup">
                  {githubUsername ? <span>@{githubUsername}</span> : null}
                  <span>参加済み</span>
                </div>
              </div>
            );
          })}

          {pendingStudents.map((rosterRow) => (
            <div className="member-row pending" key={rosterRow.id}>
              <div>
                <strong>{rosterRow.display_name}</strong>
                <span>{rosterRow.email}</span>
              </div>
              <div className="member-setup">
                {rosterRow.github_username ? <span>@{rosterRow.github_username}</span> : null}
                <span>未参加</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
};

const StatusCounters = ({
  statusCounts,
  compact = false
}: {
  statusCounts: Record<ThreadStatus, number>;
  compact?: boolean;
}): ReactElement => (
  <div className={compact ? "status-counter-grid compact" : "status-counter-grid"}>
    {(["open", "in_progress", "waiting_student"] as ThreadStatus[]).map((status) => (
      <div className="status-counter" key={status}>
        <span>{statusLabels[status]}</span>
        <strong>{statusCounts[status]}</strong>
      </div>
    ))}
  </div>
);

const MemberPanel = ({
  title,
  members
}: {
  title: string;
  members: MemberSummary[];
}): ReactElement => (
  <article className="detail-panel member-panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Members</p>
        <h2>{title}</h2>
      </div>
      <span className="status-pill pending">{members.length} 人</span>
    </div>

    {members.length === 0 ? (
      <p className="muted">まだメンバーがいません。</p>
    ) : (
      <div className="member-list">
        {members.map((member) => (
          <div className="member-row" key={member.membership.id}>
            <div>
              <strong>{member.user?.display_name ?? "Unknown user"}</strong>
              <span>{member.user?.email ?? "メール未取得"}</span>
            </div>
            <div className="member-setup">
              <span>
                {member.githubConnection?.github_username ??
                  member.user?.github_username ??
                  "GitHub未設定"}
              </span>
              <span>{sshStatusLabels[member.githubConnection?.ssh_status ?? "unknown"]}</span>
            </div>
          </div>
        ))}
      </div>
    )}
  </article>
);

const TeacherPageState = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
