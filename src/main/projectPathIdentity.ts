import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { normalize, resolve } from "node:path";

export const canonicalizePath = async (path: string): Promise<string> => {
  const resolvedPath = await realpath(path).catch(() => resolve(path));
  const normalizedPath = normalize(resolvedPath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
};

export const createLocalPathHash = (rootPath: string): string => {
  return createHash("sha256").update(rootPath).digest("hex");
};
