export interface PatchProposalDraft {
  targetFilePath: string;
  baseCommitSha: string | null;
  explanation: string;
  patchText: string;
}

export type AiPatchProposalDraft = PatchProposalDraft;

export type AiPatchProposalParseErrorCode =
  | "EMPTY_OUTPUT"
  | "INVALID_JSON"
  | "INVALID_SCHEMA"
  | "INVALID_TARGET_PATH"
  | "INVALID_BASE_COMMIT"
  | "INVALID_PATCH"
  | "TARGET_MISMATCH"
  | "MULTI_FILE_PATCH";

export interface AiPatchProposalParseError {
  code: AiPatchProposalParseErrorCode;
  message: string;
}

export type AiPatchProposalParseResult =
  | {
      ok: true;
      proposal: PatchProposalDraft;
    }
  | {
      ok: false;
      error: AiPatchProposalParseError;
    };

const maxPatchProposalChars = 200_000;

const deniedPathSegments = new Set([
  ".ask",
  ".env",
  ".git",
  ".hg",
  ".netrc",
  ".npmrc",
  ".svn",
  ".ssh",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getStringField = (
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string | null => {
  const value = record[snakeKey] ?? record[camelKey];
  return typeof value === "string" ? value.trim() : null;
};

const extractJsonCandidate = (value: string): string => {
  const trimmed = value.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);

  if (fencedMatch) {
    return fencedMatch[1]?.trim() ?? "";
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
};

export const normalizePatchTargetPath = (rawPath: string): string | null => {
  const strippedPath = rawPath
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/^[ab]\//, "");

  if (
    !strippedPath ||
    strippedPath === "/dev/null" ||
    strippedPath.includes("\0") ||
    strippedPath.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(strippedPath) ||
    strippedPath.startsWith("/") ||
    strippedPath.startsWith("../")
  ) {
    return null;
  }

  const segments = strippedPath.split("/").filter(Boolean);

  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || deniedPathSegments.has(segment)
    )
  ) {
    return null;
  }

  return segments.join("/");
};

export const validatePatchProposalDraft = (
  draft: PatchProposalDraft
): AiPatchProposalParseResult => {
  const targetFilePath = draft.targetFilePath.trim();
  const patchText = draft.patchText.trim();
  const explanation = draft.explanation.trim();
  const baseCommitSha = draft.baseCommitSha?.trim() || null;

  if (!targetFilePath || !patchText || !explanation) {
    return {
      ok: false,
      error: {
        code: "INVALID_SCHEMA",
        message: "Patch proposal requires target_file_path, patch_text, and explanation."
      }
    };
  }

  const normalizedTargetPath = normalizePatchTargetPath(targetFilePath);

  if (!normalizedTargetPath) {
    return {
      ok: false,
      error: {
        code: "INVALID_TARGET_PATH",
        message: "Patch proposal target path is not safe."
      }
    };
  }

  if (baseCommitSha && !/^[a-f0-9]{7,64}$/i.test(baseCommitSha)) {
    return {
      ok: false,
      error: {
        code: "INVALID_BASE_COMMIT",
        message: "Patch proposal base_commit_sha must be a Git commit SHA."
      }
    };
  }

  if (patchText.length > maxPatchProposalChars || !hasUnifiedDiffStructure(patchText)) {
    return {
      ok: false,
      error: {
        code: "INVALID_PATCH",
        message: "Patch proposal must include a unified diff."
      }
    };
  }

  const { targetFiles, invalidPath } = parsePatchTargetFiles(patchText);

  if (invalidPath || targetFiles.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_PATCH",
        message: "Patch proposal diff target files are invalid."
      }
    };
  }

  if (targetFiles.length > 1) {
    return {
      ok: false,
      error: {
        code: "MULTI_FILE_PATCH",
        message: "Patch proposals currently support one target file."
      }
    };
  }

  if (targetFiles[0] !== normalizedTargetPath) {
    return {
      ok: false,
      error: {
        code: "TARGET_MISMATCH",
        message: "Patch proposal target_file_path must match the unified diff target."
      }
    };
  }

  return {
    ok: true,
    proposal: {
      targetFilePath: normalizedTargetPath,
      baseCommitSha,
      explanation,
      patchText: patchText.endsWith("\n") ? patchText : `${patchText}\n`
    }
  };
};

const parseGitDiffLine = (line: string): string[] => {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match ? [match[1], match[2]] : [];
};

const hasUnifiedDiffStructure = (patchText: string): boolean => {
  const lines = patchText.split(/\r?\n/);
  return (
    lines.some((line) => line.startsWith("diff --git ")) &&
    lines.some((line) => line.startsWith("--- ")) &&
    lines.some((line) => line.startsWith("+++ ")) &&
    lines.some((line) => line.startsWith("@@ "))
  );
};

export const parsePatchTargetFiles = (
  patchText: string
): { targetFiles: string[]; invalidPath: boolean } => {
  const targetFiles = new Set<string>();
  let invalidPath = false;

  const addPath = (rawPath: string): void => {
    const normalizedPath = normalizePatchTargetPath(rawPath);

    if (!normalizedPath) {
      invalidPath = true;
      return;
    }

    targetFiles.add(normalizedPath);
  };

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      for (const rawPath of parseGitDiffLine(line)) {
        addPath(rawPath);
      }
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split(/\t/)[0]?.trim() ?? "";

      if (rawPath && rawPath !== "/dev/null") {
        addPath(rawPath);
      }
    }
  }

  return { targetFiles: [...targetFiles].sort(), invalidPath };
};

export const parseAiPatchProposalOutput = (output: string): AiPatchProposalParseResult => {
  const jsonCandidate = extractJsonCandidate(output);

  if (!jsonCandidate) {
    return {
      ok: false,
      error: {
        code: "EMPTY_OUTPUT",
        message: "AI patch output is empty."
      }
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON",
        message: "AI patch output must be a JSON object."
      }
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: {
        code: "INVALID_SCHEMA",
        message: "AI patch output must be a JSON object."
      }
    };
  }

  const targetFilePath = getStringField(parsed, "target_file_path", "targetFilePath");
  const patchText = getStringField(parsed, "patch_text", "patchText");
  const explanation = getStringField(parsed, "explanation", "explanation");
  const rawBaseCommit = parsed.base_commit_sha ?? parsed.baseCommitSha;
  const baseCommitSha =
    typeof rawBaseCommit === "string" && rawBaseCommit.trim() ? rawBaseCommit.trim() : null;

  if (!targetFilePath || !patchText || !explanation) {
    return {
      ok: false,
      error: {
        code: "INVALID_SCHEMA",
        message: "AI patch output requires target_file_path, patch_text, and explanation."
      }
    };
  }

  return validatePatchProposalDraft({
    targetFilePath,
    baseCommitSha,
    explanation,
    patchText
  });
};
