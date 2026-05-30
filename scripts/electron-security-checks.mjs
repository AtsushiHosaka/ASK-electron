import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const rootDir = new URL("..", import.meta.url).pathname;

const failures = [];

const readText = (path) => readFile(join(rootDir, path), "utf8");

const fail = (message) => {
  failures.push(message);
};

const expectIncludes = (source, expected, label) => {
  if (!source.includes(expected)) {
    fail(`${label}: expected to find ${expected}`);
  }
};

const expectNotMatch = (source, pattern, label) => {
  if (pattern.test(source)) {
    fail(`${label}: matched forbidden pattern ${pattern}`);
  }
};

const listFiles = async (dir) => {
  const entries = await readdir(join(rootDir, dir), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
      continue;
    }

    files.push(path);
  }

  return files;
};

const checkMainWindowSecurity = async () => {
  const source = await readText("src/main/index.ts");

  expectIncludes(source, "contextIsolation: true", "BrowserWindow security");
  expectIncludes(source, "nodeIntegration: false", "BrowserWindow security");
  expectIncludes(source, "sandbox: true", "BrowserWindow security");
  expectIncludes(source, 'preload: join(__dirname, "../preload/index.js")', "Preload path");
  expectIncludes(source, 'webContents.on("will-navigate"', "Navigation guard");
  expectIncludes(source, 'webContents.on("will-redirect"', "Redirect guard");
  expectIncludes(source, "webContents.setWindowOpenHandler", "Window open guard");
  expectIncludes(source, "shell.openExternal", "External URL handoff");

  expectNotMatch(source, /nodeIntegration:\s*true/, "BrowserWindow security");
  expectNotMatch(source, /contextIsolation:\s*false/, "BrowserWindow security");
  expectNotMatch(source, /sandbox:\s*false/, "BrowserWindow security");
  expectNotMatch(source, /webSecurity:\s*false/, "BrowserWindow security");
  expectNotMatch(source, /allowRunningInsecureContent:\s*true/, "BrowserWindow security");
};

const checkPreloadApi = async () => {
  const source = await readText("src/preload/index.ts");

  expectIncludes(source, 'contextBridge.exposeInMainWorld("ask", api)', "Preload API");
  expectIncludes(source, "IpcChannel.", "Preload IPC whitelist");

  expectNotMatch(source, /exposeInMainWorld\([^)]*ipcRenderer/s, "Preload API");
  expectNotMatch(source, /ipcRenderer\.send\(/, "Preload API");
  expectNotMatch(source, /ipcRenderer\.on\(/, "Preload API");
  expectNotMatch(source, /process\.env/, "Preload secrets");
};

const checkIpcContract = async () => {
  const source = await readText("src/shared/ipc.ts");

  expectIncludes(source, "export const IpcChannel", "IPC contract");
  expectIncludes(source, "IpcRequestMap", "IPC contract");
  expectIncludes(source, "IpcResponseMap", "IPC contract");
  expectIncludes(source, "RendererApi", "IPC contract");

  expectNotMatch(source, /run-?command|exec-?command|shell-?command/i, "IPC command surface");
};

const checkRendererRestrictions = async () => {
  const rendererFiles = (await listFiles("src/renderer/src")).filter((path) =>
    /\.(ts|tsx)$/.test(path)
  );
  const forbiddenImportPattern =
    /(?:import\s+.*?\s+from\s+["'](?:electron|node:[^"']+|fs|path|child_process|os|crypto)["'])|(?:await\s+import\(["'](?:electron|node:[^"']+|fs|path|child_process|os|crypto)["']\))/s;

  for (const file of rendererFiles) {
    const source = await readText(file);
    const label = `Renderer restriction ${relative(rootDir, join(rootDir, file))}`;

    expectNotMatch(source, forbiddenImportPattern, label);
    expectNotMatch(source, /process\.env/, label);
    expectNotMatch(source, /ipcRenderer/, label);
  }
};

const checkSecretExposure = async () => {
  const envExample = await readText(".env.example");
  const envAssignments = envExample
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  const preload = await readText("src/preload/index.ts");

  expectNotMatch(envAssignments, /SERVICE_ROLE|SECRET|PASSWORD|TOKEN|PRIVATE_KEY/i, ".env.example");
  expectNotMatch(preload, /VITE_SUPABASE|SUPABASE_SERVICE|SERVICE_ROLE|SECRET/i, "Preload secrets");
};

const checkReleaseChecklist = async () => {
  const baseline = await readText("docs/security/electron-security-baseline.md");

  expectIncludes(baseline, "contextIsolation", "Security baseline");
  expectIncludes(baseline, "nodeIntegration", "Security baseline");
  expectIncludes(baseline, "IPC", "Security baseline");
  expectIncludes(baseline, "Navigation", "Security baseline");
};

await checkMainWindowSecurity();
await checkPreloadApi();
await checkIpcContract();
await checkRendererRestrictions();
await checkSecretExposure();
await checkReleaseChecklist();

if (failures.length > 0) {
  console.error("Electron security checks failed:");

  for (const failure of failures) {
    console.error(`- ${failure}`);
  }

  process.exit(1);
}

console.log("Electron security checks passed.");
