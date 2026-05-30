import {
  runAiAssistPipelineWithProvider,
  type AiAssistRequest,
  type AiAssistResponse,
  type AiProvider
} from "../shared/aiPipeline";
import { createConfiguredAiProvider } from "./aiProvider";

const activeProvider = createConfiguredAiProvider();

const getSafeErrorFields = (error: unknown): { code?: string; message: string } => {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : "Unknown provider error";

  return code ? { code, message } : { message };
};

const logAiUsage = (audit: AiAssistResponse["audit"]): void => {
  console.info("[ask:ai]", JSON.stringify(audit));
};

export const runAiAssistPipeline = async (
  request: AiAssistRequest,
  provider: AiProvider = activeProvider
): Promise<AiAssistResponse> => {
  return runAiAssistPipelineWithProvider(request, provider, {
    onAudit: logAiUsage,
    onProviderError: (error, failedProvider) => {
      console.error("[ask:ai] provider failed", {
        event: "provider_error",
        providerId: failedProvider.id,
        ...getSafeErrorFields(error)
      });
    }
  });
};
