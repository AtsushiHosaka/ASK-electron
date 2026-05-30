export type SecretScanSeverity = "block" | "warn";

export type SecretScanSourceType = "text" | "path";

export type SecretFindingKind =
  | "blocked_path"
  | "sensitive_path_hint"
  | "private_key"
  | "github_token"
  | "api_key"
  | "secret_assignment"
  | "secret_keyword";

export interface SecretScanTextEntry {
  label: string;
  value: string;
}

export interface SecretScanFinding {
  id: string;
  kind: SecretFindingKind;
  severity: SecretScanSeverity;
  sourceType: SecretScanSourceType;
  sourceLabel: string;
  message: string;
  preview: string;
  lineNumber: number | null;
  canAllow: boolean;
}

export interface SecretScanResult {
  blocked: boolean;
  hasWarnings: boolean;
  findings: SecretScanFinding[];
  activeFindings: SecretScanFinding[];
  allowedFindings: SecretScanFinding[];
  blockedFindings: SecretScanFinding[];
  warningFindings: SecretScanFinding[];
}

export interface SecretScanInput {
  textEntries?: SecretScanTextEntry[];
  filePaths?: string[];
  allowedFindingIds?: string[];
}

interface PatternRule {
  kind: SecretFindingKind;
  severity: SecretScanSeverity;
  message: string;
  pattern: RegExp;
}

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

const privateKeyPathExtensions = [".key", ".pem", ".p12", ".pfx"];

const textRules: PatternRule[] = [
  {
    kind: "private_key",
    severity: "block",
    message: "秘密鍵本文が含まれています。",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi
  },
  {
    kind: "github_token",
    severity: "block",
    message: "GitHub token らしき値が含まれています。",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g
  },
  {
    kind: "api_key",
    severity: "block",
    message: "API key らしき値が含まれています。",
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

const normalizePath = (path: string): string => {
  return path.replaceAll("\\", "/").trim();
};

const getPathFileName = (path: string): string => {
  const normalizedPath = normalizePath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.at(-1) ?? normalizedPath;
};

const fnvHash = (value: string): string => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

const createFindingId = (
  kind: SecretFindingKind,
  severity: SecretScanSeverity,
  sourceLabel: string,
  preview: string
): string => {
  return `${severity}:${kind}:${fnvHash(`${sourceLabel}\n${preview}`)}`;
};

const redactPreview = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 180);

  return compact
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

const createFinding = ({
  kind,
  severity,
  sourceType,
  sourceLabel,
  message,
  preview,
  lineNumber
}: Omit<SecretScanFinding, "id" | "canAllow">): SecretScanFinding => ({
  id: createFindingId(kind, severity, sourceLabel, preview),
  kind,
  severity,
  sourceType,
  sourceLabel,
  message,
  preview,
  lineNumber,
  canAllow: severity === "warn"
});

const scanPath = (path: string): SecretScanFinding[] => {
  const normalizedPath = normalizePath(path);
  const lowerPath = normalizedPath.toLowerCase();
  const fileName = getPathFileName(lowerPath);

  if (!normalizedPath) {
    return [];
  }

  if (
    blockedPathFileNames.has(fileName) ||
    (fileName.startsWith(".env.") && fileName !== ".env.example") ||
    privateKeyPathExtensions.some((extension) => fileName.endsWith(extension)) ||
    lowerPath.split("/").includes(".ssh")
  ) {
    return [
      createFinding({
        kind: "blocked_path",
        severity: "block",
        sourceType: "path",
        sourceLabel: normalizedPath,
        message: "送信禁止対象のファイルパスです。",
        preview: normalizedPath,
        lineNumber: null
      })
    ];
  }

  if (lowerPath.includes("secret") || lowerPath.includes("token")) {
    return [
      createFinding({
        kind: "sensitive_path_hint",
        severity: "warn",
        sourceType: "path",
        sourceLabel: normalizedPath,
        message: "秘密情報に関係する可能性があるファイル名です。",
        preview: normalizedPath,
        lineNumber: null
      })
    ];
  }

  return [];
};

const scanTextEntry = (entry: SecretScanTextEntry): SecretScanFinding[] => {
  const findings: SecretScanFinding[] = [];
  const lines = entry.value.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    for (const rule of textRules) {
      const matches = line.matchAll(rule.pattern);

      for (const match of matches) {
        const rawMatch = match[0] ?? "";
        const preview = redactPreview(rawMatch || line);

        if (!preview) {
          continue;
        }

        findings.push(
          createFinding({
            kind: rule.kind,
            severity: rule.severity,
            sourceType: "text",
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

const dedupeFindings = (findings: SecretScanFinding[]): SecretScanFinding[] => {
  const seen = new Set<string>();
  const deduped: SecretScanFinding[] = [];

  for (const finding of findings) {
    if (seen.has(finding.id)) {
      continue;
    }

    seen.add(finding.id);
    deduped.push(finding);
  }

  return deduped;
};

export const scanSecrets = ({
  textEntries = [],
  filePaths = [],
  allowedFindingIds = []
}: SecretScanInput): SecretScanResult => {
  const allowedIds = new Set(allowedFindingIds);
  const findings = dedupeFindings([
    ...filePaths.flatMap((path) => scanPath(path)),
    ...textEntries.flatMap((entry) => scanTextEntry(entry))
  ]);
  const allowedFindings = findings.filter(
    (finding) => finding.canAllow && allowedIds.has(finding.id)
  );
  const activeFindings = findings.filter(
    (finding) => finding.severity === "block" || !allowedIds.has(finding.id)
  );
  const blockedFindings = activeFindings.filter((finding) => finding.severity === "block");
  const warningFindings = activeFindings.filter((finding) => finding.severity === "warn");

  return {
    blocked: blockedFindings.length > 0,
    hasWarnings: warningFindings.length > 0,
    findings,
    activeFindings,
    allowedFindings,
    blockedFindings,
    warningFindings
  };
};

export const scanSecretPaths = (filePaths: string[]): SecretScanResult => {
  return scanSecrets({ filePaths });
};
