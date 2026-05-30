import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";
import { configureProjectRootRegistryStorage } from "./projectRootRegistry";

let mainWindow: BrowserWindow | null = null;

const externalUrlHosts = new Set(["github.com", "docs.github.com", "supabase.com"]);

const isAllowedExternalUrl = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && externalUrlHosts.has(parsedUrl.hostname);
  } catch {
    return false;
  }
};

const isAllowedAppNavigation = (url: string, rendererUrl: string | undefined): boolean => {
  try {
    const parsedUrl = new URL(url);

    if (app.isPackaged) {
      return parsedUrl.protocol === "file:";
    }

    if (!rendererUrl) {
      return false;
    }

    return parsedUrl.origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
};

const createWindow = (): void => {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "ASK",
    show: false,
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppNavigation(url, rendererUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedAppNavigation(url, rendererUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  if (!app.isPackaged && rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

app
  .whenReady()
  .then(async () => {
    await configureProjectRootRegistryStorage(join(app.getPath("userData"), "project-roots.json"));
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error: unknown) => {
    console.error("Failed to start ASK Electron app", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
