# AI Provider Pipeline

Issue #25 introduces a main-process AI boundary that future AI features can call through
`window.ask.ai.generate`.

## Boundary

- Renderer code sends an `AiAssistRequest` with a task and labeled context entries.
- Main validates the request shape before any provider call.
- Main minimizes context by entry count, per-entry limits, and total character limits.
- Main runs the AI safety scanner before provider invocation. A blocked secret finding returns a
  fallback response and the provider is not called.
- Provider output is returned only as a suggestion. The response explicitly marks it as requiring
  human review and non-executable.

## Provider

The production provider is an OpenAI-compatible HTTPS Chat Completions endpoint configured in the
Electron main process only. Set `ASK_AI_PROVIDER_API_KEY`, `ASK_AI_PROVIDER_MODEL`, and optionally
`ASK_AI_PROVIDER_URL` / `ASK_AI_PROVIDER_TIMEOUT_MS` in the main process environment. The renderer
does not receive provider credentials, and provider failures return the existing fallback response
so manual question creation can continue.

## Streaming Decision

Streaming is disabled for the MVP pipeline. The response records whether streaming was requested
and why it was not used. This keeps the first AI boundary simple for audit logging, fallback, and
secret blocking; a later provider can add streaming without changing renderer task contracts.

## Audit

Every pipeline result includes a sanitized `audit` candidate with the task, provider ID, provider
mode, status, character counts, and secret finding count. It does not include prompt text, model
output, raw paths, or secret previews.
