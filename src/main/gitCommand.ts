import { execFile } from "node:child_process";

export interface GitCommandResult {
  status: "completed" | "missing" | "timeout" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface GitCommandOptions {
  maxBufferBytes?: number;
  maxOutputLength?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_LENGTH = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const sanitizeOutput = (
  value: string,
  maxOutputLength: number
): { text: string; truncated: boolean } => {
  const cleaned = value
    .split("")
    .filter((char) => {
      const codePoint = char.charCodeAt(0);
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("");

  return {
    text: cleaned.slice(0, maxOutputLength).trim(),
    truncated: cleaned.length > maxOutputLength
  };
};

export const runGit = (
  rootPath: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<GitCommandResult> => {
  const maxOutputLength = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;

  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", rootPath, ...args],
      {
        encoding: "utf8",
        maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        shell: false,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const cleanStdout = sanitizeOutput(stdout, maxOutputLength);
        const cleanStderr = sanitizeOutput(stderr, maxOutputLength);

        if (!error) {
          resolve({
            status: "completed",
            exitCode: 0,
            stdout: cleanStdout.text,
            stderr: cleanStderr.text,
            stdoutTruncated: cleanStdout.truncated,
            stderrTruncated: cleanStderr.truncated
          });
          return;
        }

        const commandError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
          code?: string | number | null;
        };

        if (commandError.code === "ENOENT") {
          resolve({
            status: "missing",
            exitCode: null,
            stdout: cleanStdout.text,
            stderr: cleanStderr.text,
            stdoutTruncated: cleanStdout.truncated,
            stderrTruncated: cleanStderr.truncated
          });
          return;
        }

        if (commandError.killed || commandError.signal === "SIGTERM") {
          resolve({
            status: "timeout",
            exitCode: null,
            stdout: cleanStdout.text,
            stderr: cleanStderr.text,
            stdoutTruncated: cleanStdout.truncated,
            stderrTruncated: cleanStderr.truncated
          });
          return;
        }

        resolve({
          status: typeof commandError.code === "number" ? "completed" : "error",
          exitCode: typeof commandError.code === "number" ? commandError.code : null,
          stdout: cleanStdout.text,
          stderr: cleanStderr.text,
          stdoutTruncated: cleanStdout.truncated,
          stderrTruncated: cleanStderr.truncated
        });
      }
    );
  });
};
