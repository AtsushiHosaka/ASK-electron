# ASK Electron

ASK Electron is a desktop app for programming schools. It helps students send useful coding questions by collecting GitHub context, code diffs, environment information, and chat history for teachers and mentors.

## Development

Copy the public environment template and fill in your Supabase project values:

```sh
cp .env.example .env
```

Required values:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Start the app:

```sh
npm install
npm run dev
```

Useful scripts:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Local login fixtures and role-based QA steps are documented in
[`docs/qa/test-accounts-and-login-fixtures.md`](docs/qa/test-accounts-and-login-fixtures.md).

## Security Boundaries

- The renderer only receives the Supabase URL and `sb_publishable_...` key.
- Supabase secret keys, service role keys, database passwords, GitHub client secrets, and AI provider keys must not be bundled into the Electron app.
- Electron runs with `contextIsolation: true`, `nodeIntegration: false`, and a sandboxed renderer.
- Renderer code talks to local system features only through the typed preload API in `src/shared/ipc.ts`.

## Project Structure

```text
src/main      Electron main process
src/preload   Typed bridge exposed through contextBridge
src/renderer  React renderer app
src/shared    Types shared across main, preload, and renderer
```
