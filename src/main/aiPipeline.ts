import {
  runAiAssistPipelineWithProvider,
  type AiAssistRequest,
  type AiAssistResponse,
  type AiProvider
} from "../shared/aiPipeline";
import { createMockAiProvider } from "./aiProvider";

const activeProvider = createMockAiProvider();

const logAiUsage = (audit: AiAssistResponse["audit"]): void => {
  console.info("[ask:ai]", JSON.stringify(audit));
};

const clipLogValue = (value: string, maxLength: number): string => {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
};

const safeErrorFields = (error: unknown): { message: string; code: string | null } => {
  const errorRecord = typeof error === "object" && error !== null ? error : {};
  const rawCode = "code" in errorRecord ? errorRecord.code : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown provider error";

  return {
    message: clipLogValue(message, 240),
    code: typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : null
  };
};

export const runAiAssistPipeline = async (
  request: AiAssistRequest,
  provider: AiProvider = activeProvider
): Promise<AiAssistResponse> => {
  return runAiAssistPipelineWithProvider(request, provider, {
    onAudit: logAiUsage,
    onProviderError: (error) => {
      console.error(
        "[ask:ai] provider failed",
        JSON.stringify({
          event: "provider_error",
          providerId: provider.id,
          ...safeErrorFields(error)
        })
      );
    }
  });
};
