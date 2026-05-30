export const aiAssistTasks = [
  "question_rewrite",
  "error_summary",
  "cause_candidates",
  "patch_proposal"
] as const;

export type AiAssistTask = (typeof aiAssistTasks)[number];

export const aiContextKinds = [
  "user_text",
  "error",
  "command",
  "file_path",
  "diff",
  "environment",
  "thread_excerpt",
  "patch"
] as const;

export type AiContextKind = (typeof aiContextKinds)[number];

export type AiProviderMode = "mock" | "remote";
export type AiAssistStatus = "completed" | "blocked" | "fallback";
export type AiSecretSeverity = "block" | "warn";

export interface AiContextEntry {
  label: string;
  kind: AiContextKind;
  value: string;
}

export interface AiAssistOptions {
  locale?: "ja" | "en";
  maxOutputChars?: number;
  streaming?: boolean;
}

export interface AiAssistRequest {
  task: AiAssistTask;
  context: AiContextEntry[];
  options?: AiAssistOptions;
  projectId?: string | null;
  threadId?: string | null;
}

export interface AiMinimizedContextEntry extends AiContextEntry {
  originalChars: number;
  valueChars: number;
  truncated: boolean;
}

export interface AiMinimizationSummary {
  inputEntryCount: number;
  outputEntryCount: number;
  omittedEntryCount: number;
  inputChars: number;
  outputChars: number;
  truncated: boolean;
  maxTotalChars: number;
}

export type AiSecretFindingKind =
  | "blocked_path"
  | "private_key"
  | "github_token"
  | "provider_api_key"
  | "secret_assignment"
  | "secret_keyword";

export interface AiSecretFinding {
  kind: AiSecretFindingKind;
  severity: AiSecretSeverity;
  sourceLabel: string;
  message: string;
  preview: string;
  lineNumber: number | null;
}

export interface AiSecretScanSummary {
  blocked: boolean;
  findingCount: number;
  blockedFindingCount: number;
  warningFindingCount: number;
  findings: AiSecretFinding[];
}

export interface AiProviderPrompt {
  system: string;
  user: string;
}

export interface AiProviderRequest {
  task: AiAssistTask;
  prompt: AiProviderPrompt;
  context: AiMinimizedContextEntry[];
  options: Required<AiAssistOptions>;
}

export interface AiProviderUsage {
  inputChars: number;
  outputChars: number;
}

export interface AiProviderResult {
  text: string;
  usage: AiProviderUsage;
}

export interface AiProvider {
  id: string;
  mode: AiProviderMode;
  supportsStreaming: boolean;
  generate: (request: AiProviderRequest) => Promise<AiProviderResult>;
}

export interface AiAssistOutput {
  text: string;
  kind: "suggestion";
  requiresHumanReview: true;
}

export interface AiAuditCandidate {
  eventType: "ai_used";
  operation: string;
  decision: "blocked" | "failed" | "succeeded";
  projectId: string | null;
  threadId: string | null;
  metadata: {
    task: AiAssistTask;
    providerId: string;
    providerMode: AiProviderMode;
    status: AiAssistStatus;
    inputChars: number;
    outputChars: number;
    secretFindingCount: number;
    streamingUsed: boolean;
  };
}

export interface AiAssistResponse {
  contractVersion: "v1";
  status: AiAssistStatus;
  canContinue: boolean;
  task: AiAssistTask;
  provider: {
    id: string;
    mode: AiProviderMode;
  };
  streaming: {
    requested: boolean;
    used: false;
    reason: "disabled_for_mvp" | "provider_unsupported";
  };
  output: AiAssistOutput | null;
  fallback: {
    reason: "secret_detected" | "provider_failed";
    message: string;
  } | null;
  safety: {
    minimization: AiMinimizationSummary;
    secretScan: AiSecretScanSummary;
    executableOutput: false;
  };
  audit: AiAuditCandidate;
}

export type AiFallbackReason = NonNullable<AiAssistResponse["fallback"]>["reason"];

export interface RunAiAssistPipelineOptions {
  onAudit?: (audit: AiAuditCandidate) => void;
  onProviderError?: (error: unknown, provider: AiProvider) => void;
}

export const AI_PIPELINE_LIMITS = {
  maxContextEntries: 12,
  maxLabelChars: 80,
  maxTotalContextChars: 12_000,
  maxOutputChars: 4_000,
  maxContextValueCharsByKind: {
    user_text: 3_000,
    error: 4_000,
    command: 1_000,
    file_path: 1_000,
    diff: 6_000,
    environment: 3_000,
    thread_excerpt: 4_000,
    patch: 6_000
  } satisfies Record<AiContextKind, number>
} as const;

export const AI_ASSIST_REQUEST_LIMITS = {
  maxContextItems: AI_PIPELINE_LIMITS.maxContextEntries,
  maxContextStringChars: AI_PIPELINE_LIMITS.maxTotalContextChars,
  maxContextTotalBytes: AI_PIPELINE_LIMITS.maxTotalContextChars * 4
} as const;

export interface AiAssistRequestLimitViolation {
  code: "TOO_MANY_CONTEXT_ITEMS" | "CONTEXT_STRING_TOO_LONG" | "CONTEXT_TOO_LARGE";
  message: string;
}

interface PatternRule {
  kind: Exclude<AiSecretFindingKind, "blocked_path">;
  severity: AiSecretSeverity;
  message: string;
  pattern: RegExp;
}

const taskInstructions: Record<AiAssistTask, string> = {
  question_rewrite:
    "質問文を先生が状況判断しやすい形に整理する。事実と推測を分け、送信者が確認すべき不足情報を短く示す。",
  error_summary: "エラー文と実行状況を要約する。原因断定は避け、再現条件と重要なログだけを残す。",
  cause_candidates:
    "考えられる原因候補を複数件出す。各候補は確度を 高/中/低 のどれかで示し、根拠、次に確認するコマンドやファイル、断定できない理由を分ける。危険な操作や自動実行は提案しない。",
  patch_proposal:
    "修正案を unified diff のレビュー用パッチとして作る。出力は JSON object のみとし、target_file_path, base_commit_sha, explanation, patch_text を含める。patch_text は単一ファイルだけを対象にした unified diff にする。AI 出力は proposed の提案に限定し、ローカル適用や実行は行わない。"
};

const fallbackMessages: Record<AiFallbackReason, string> = {
  secret_detected:
    "秘密情報の可能性がある内容を検出したため、AI には送信していません。入力を見直してから手動で質問作成を続けてください。",
  provider_failed:
    "AI 応答を取得できませんでした。AI なしでも質問作成は継続できます。入力済みの内容をそのまま送信できます。"
};

const textSecretRules: PatternRule[] = [
  {
    kind: "private_key",
    severity: "block",
    message: "秘密鍵本文が含まれています。",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
  },
  {
    kind: "github_token",
    severity: "block",
    message: "GitHub token らしき値が含まれています。",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g
  },
  {
    kind: "provider_api_key",
    severity: "block",
    message: "AI provider や外部サービスの API key らしき値が含まれています。",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sb_secret_[A-Za-z0-9_-]{20,})\b/g
  },
  {
    kind: "secret_assignment",
    severity: "block",
    message: "秘密情報名への実値代入らしき内容があります。",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd)\b\s*[:=]\s*["']?(?!YOUR_|your_|REPLACE_|replace_|example|dummy|test|xxx|null\b|undefined\b)[A-Za-z0-9_./+=:@-]{16,}/gi
  },
  {
    kind: "secret_keyword",
    severity: "warn",
    message: "秘密情報に関係する語が含まれています。",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd)\b/gi
  }
];

const blockedPathFileNames = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
]);

const blockedPathExtensions = [".key", ".pem", ".p12", ".pfx"];

export const isAiAssistTask = (value: unknown): value is AiAssistTask => {
  return typeof value === "string" && aiAssistTasks.includes(value as AiAssistTask);
};

export const isAiContextKind = (value: unknown): value is AiContextKind => {
  return typeof value === "string" && aiContextKinds.includes(value as AiContextKind);
};

const getUtf8ByteLength = (value: string): number => {
  return new TextEncoder().encode(value).byteLength;
};

export const getAiAssistRequestLimitViolation = (
  request: AiAssistRequest
): AiAssistRequestLimitViolation | null => {
  if (request.context.length > AI_ASSIST_REQUEST_LIMITS.maxContextItems) {
    return {
      code: "TOO_MANY_CONTEXT_ITEMS",
      message: "AI context item count exceeds the allowed limit."
    };
  }

  let totalBytes = 0;

  for (const entry of request.context) {
    const strings = [entry.label, entry.kind, entry.value];

    if (
      entry.label.length > AI_PIPELINE_LIMITS.maxLabelChars ||
      entry.value.length > AI_ASSIST_REQUEST_LIMITS.maxContextStringChars
    ) {
      return {
        code: "CONTEXT_STRING_TOO_LONG",
        message: "AI context string exceeds the allowed limit."
      };
    }

    totalBytes += strings.reduce((total, value) => total + getUtf8ByteLength(value), 0);

    if (totalBytes > AI_ASSIST_REQUEST_LIMITS.maxContextTotalBytes) {
      return {
        code: "CONTEXT_TOO_LARGE",
        message: "AI context payload exceeds the allowed byte limit."
      };
    }
  }

  return null;
};

export const createDefaultAiOptions = (
  options: AiAssistOptions = {}
): Required<AiAssistOptions> => {
  const requestedMaxOutput = Number.isFinite(options.maxOutputChars)
    ? Math.max(1, Math.floor(options.maxOutputChars ?? AI_PIPELINE_LIMITS.maxOutputChars))
    : AI_PIPELINE_LIMITS.maxOutputChars;

  return {
    locale: options.locale ?? "ja",
    maxOutputChars: Math.min(requestedMaxOutput, AI_PIPELINE_LIMITS.maxOutputChars),
    streaming: options.streaming ?? false
  };
};

const normalizeWhitespace = (value: string): string => {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const clipText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, Math.max(0, maxChars)).trimEnd();
};

const normalizeLabel = (label: string): string => {
  const trimmed = normalizeWhitespace(label).replace(/\n/g, " ");
  return clipText(trimmed || "context", AI_PIPELINE_LIMITS.maxLabelChars);
};

export const minimizeAiAssistRequest = (
  request: AiAssistRequest
): {
  context: AiMinimizedContextEntry[];
  summary: AiMinimizationSummary;
} => {
  const normalizedEntries = request.context
    .filter((entry) => isAiContextKind(entry.kind))
    .map((entry) => ({
      label: normalizeLabel(entry.label),
      kind: entry.kind,
      value: normalizeWhitespace(entry.value)
    }))
    .filter((entry) => entry.value.length > 0);
  const inputChars = normalizedEntries.reduce((total, entry) => total + entry.value.length, 0);
  const minimized: AiMinimizedContextEntry[] = [];
  let remainingChars = AI_PIPELINE_LIMITS.maxTotalContextChars;
  let omittedEntryCount = Math.max(
    0,
    normalizedEntries.length - AI_PIPELINE_LIMITS.maxContextEntries
  );

  for (const entry of normalizedEntries.slice(0, AI_PIPELINE_LIMITS.maxContextEntries)) {
    if (remainingChars <= 0) {
      omittedEntryCount += 1;
      continue;
    }

    const perEntryLimit = AI_PIPELINE_LIMITS.maxContextValueCharsByKind[entry.kind];
    const maxValueChars = Math.min(perEntryLimit, remainingChars);
    const value = clipText(entry.value, maxValueChars);

    if (!value) {
      omittedEntryCount += 1;
      continue;
    }

    minimized.push({
      ...entry,
      value,
      originalChars: entry.value.length,
      valueChars: value.length,
      truncated: value.length < entry.value.length
    });
    remainingChars -= value.length;
  }

  const outputChars = minimized.reduce((total, entry) => total + entry.valueChars, 0);
  const truncated =
    omittedEntryCount > 0 || minimized.some((entry) => entry.truncated) || outputChars < inputChars;

  return {
    context: minimized,
    summary: {
      inputEntryCount: normalizedEntries.length,
      outputEntryCount: minimized.length,
      omittedEntryCount,
      inputChars,
      outputChars,
      truncated,
      maxTotalChars: AI_PIPELINE_LIMITS.maxTotalContextChars
    }
  };
};

const normalizePath = (path: string): string => {
  return path.replaceAll("\\", "/").trim();
};

const getPathFileName = (path: string): string => {
  const segments = normalizePath(path).split("/").filter(Boolean);
  return segments.at(-1) ?? path;
};

const redactSecretPreview = (value: string): string => {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*$/i, "[redacted private key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}/g, "[redacted github token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}/g, "[redacted github token]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted api key]")
    .replace(/\bAKIA[0-9A-Z]{8,}/g, "[redacted api key]")
    .replace(/\bAIza[0-9A-Za-z_-]{8,}/g, "[redacted api key]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted api key]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}/g, "[redacted api key]")
    .replace(
      /((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd)\b\s*[:=]\s*["']?)[^\s"']{4,}/gi,
      "$1[redacted]"
    );
};

const createFinding = (finding: AiSecretFinding): AiSecretFinding => finding;

const scanPathForSecrets = (entry: AiContextEntry): AiSecretFinding[] => {
  const findings: AiSecretFinding[] = [];
  const paths = entry.value.split(/\r?\n/).map(normalizePath).filter(Boolean);

  for (const path of paths) {
    const lowerPath = path.toLowerCase();
    const fileName = getPathFileName(lowerPath);
    const blocked =
      blockedPathFileNames.has(fileName) ||
      (fileName.startsWith(".env.") && fileName !== ".env.example") ||
      blockedPathExtensions.some((extension) => fileName.endsWith(extension)) ||
      lowerPath.split("/").includes(".ssh");

    if (blocked) {
      findings.push(
        createFinding({
          kind: "blocked_path",
          severity: "block",
          sourceLabel: entry.label,
          message: "AI へ送信できないファイルパスです。",
          preview: path,
          lineNumber: null
        })
      );
    }
  }

  return findings;
};

const scanTextForSecrets = (entry: AiContextEntry): AiSecretFinding[] => {
  const findings: AiSecretFinding[] = [];
  const lines = entry.value.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    for (const rule of textSecretRules) {
      for (const match of line.matchAll(rule.pattern)) {
        const rawMatch = match[0] ?? "";
        const preview = redactSecretPreview(rawMatch || line);

        if (!preview) {
          continue;
        }

        findings.push(
          createFinding({
            kind: rule.kind,
            severity: rule.severity,
            sourceLabel: entry.label,
            message: rule.message,
            preview,
            lineNumber: lineIndex + 1
          })
        );
      }
    }
  }

  return findings;
};

const scanLabelForSecrets = (entry: AiContextEntry): AiSecretFinding[] => {
  return scanTextForSecrets({
    ...entry,
    label: `${entry.kind} label`,
    value: entry.label
  });
};

const dedupeFindings = (findings: AiSecretFinding[]): AiSecretFinding[] => {
  const seen = new Set<string>();
  const deduped: AiSecretFinding[] = [];

  for (const finding of findings) {
    const key = [
      finding.kind,
      finding.severity,
      finding.sourceLabel,
      finding.preview,
      finding.lineNumber ?? ""
    ].join(":");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
};

export const scanAiAssistRequestForSecrets = (request: AiAssistRequest): AiSecretScanSummary => {
  const findings = dedupeFindings(
    request.context.flatMap((entry) => {
      if (entry.kind === "file_path") {
        return [...scanLabelForSecrets(entry), ...scanPathForSecrets(entry)];
      }

      return [...scanLabelForSecrets(entry), ...scanTextForSecrets(entry)];
    })
  );
  const blockedFindingCount = findings.filter((finding) => finding.severity === "block").length;
  const warningFindingCount = findings.filter((finding) => finding.severity === "warn").length;

  return {
    blocked: blockedFindingCount > 0,
    findingCount: findings.length,
    blockedFindingCount,
    warningFindingCount,
    findings
  };
};

export const buildAiProviderRequest = (
  request: AiAssistRequest,
  context: AiMinimizedContextEntry[]
): AiProviderRequest => {
  const options = createDefaultAiOptions(request.options);
  const contextText = context
    .map((entry) => `### ${entry.label} [${entry.kind}]\n${entry.value}`)
    .join("\n\n");

  return {
    task: request.task,
    prompt: {
      system: [
        "You are ASK's AI assistant pipeline.",
        taskInstructions[request.task],
        "Use only the provided minimized context.",
        "Never execute, apply, or claim to have applied code or shell actions.",
        "Return concise Japanese output unless locale is en."
      ].join("\n"),
      user: contextText || "追加コンテキストなし。"
    },
    context,
    options
  };
};

const createAuditCandidate = ({
  request,
  provider,
  status,
  decision,
  inputChars,
  outputChars,
  secretFindingCount
}: {
  request: AiAssistRequest;
  provider: AiProvider;
  status: AiAssistStatus;
  decision: AiAuditCandidate["decision"];
  inputChars: number;
  outputChars: number;
  secretFindingCount: number;
}): AiAuditCandidate => ({
  eventType: "ai_used",
  operation: `ai.${request.task}`,
  decision,
  projectId: request.projectId ?? null,
  threadId: request.threadId ?? null,
  metadata: {
    task: request.task,
    providerId: provider.id,
    providerMode: provider.mode,
    status,
    inputChars,
    outputChars,
    secretFindingCount,
    streamingUsed: false
  }
});

const createPipelineResponse = ({
  request,
  provider,
  status,
  outputText,
  fallbackReason,
  minimization,
  secretScan,
  outputChars,
  decision,
  onAudit
}: {
  request: AiAssistRequest;
  provider: AiProvider;
  status: AiAssistStatus;
  outputText: string | null;
  fallbackReason: AiFallbackReason | null;
  minimization: AiMinimizationSummary;
  secretScan: AiSecretScanSummary;
  outputChars: number;
  decision: AiAuditCandidate["decision"];
  onAudit?: (audit: AiAuditCandidate) => void;
}): AiAssistResponse => {
  const audit = createAuditCandidate({
    request,
    provider,
    status,
    decision,
    inputChars: minimization.outputChars,
    outputChars,
    secretFindingCount: secretScan.findingCount
  });

  onAudit?.(audit);

  return {
    contractVersion: "v1",
    status,
    canContinue: true,
    task: request.task,
    provider: {
      id: provider.id,
      mode: provider.mode
    },
    streaming: {
      requested: request.options?.streaming ?? false,
      used: false,
      reason: provider.supportsStreaming ? "disabled_for_mvp" : "provider_unsupported"
    },
    output: outputText
      ? {
          text: outputText,
          kind: "suggestion",
          requiresHumanReview: true
        }
      : null,
    fallback: fallbackReason
      ? {
          reason: fallbackReason,
          message: fallbackMessages[fallbackReason]
        }
      : null,
    safety: {
      minimization,
      secretScan,
      executableOutput: false
    },
    audit
  };
};

export const runAiAssistPipelineWithProvider = async (
  request: AiAssistRequest,
  provider: AiProvider,
  options: RunAiAssistPipelineOptions = {}
): Promise<AiAssistResponse> => {
  const { context, summary } = minimizeAiAssistRequest(request);
  const secretScan = scanAiAssistRequestForSecrets(request);

  if (secretScan.blocked) {
    return createPipelineResponse({
      request,
      provider,
      status: "blocked",
      outputText: null,
      fallbackReason: "secret_detected",
      minimization: summary,
      secretScan,
      outputChars: 0,
      decision: "blocked",
      onAudit: options.onAudit
    });
  }

  try {
    const providerRequest = buildAiProviderRequest(request, context);
    const providerResult = await provider.generate(providerRequest);

    return createPipelineResponse({
      request,
      provider,
      status: "completed",
      outputText: providerResult.text,
      fallbackReason: null,
      minimization: summary,
      secretScan,
      outputChars: providerResult.usage.outputChars,
      decision: "succeeded",
      onAudit: options.onAudit
    });
  } catch (error) {
    options.onProviderError?.(error, provider);

    return createPipelineResponse({
      request,
      provider,
      status: "fallback",
      outputText: null,
      fallbackReason: "provider_failed",
      minimization: summary,
      secretScan,
      outputChars: 0,
      decision: "failed",
      onAudit: options.onAudit
    });
  }
};
