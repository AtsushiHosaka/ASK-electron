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

export const runAiAssistPipeline = async (
  request: AiAssistRequest,
  provider: AiProvider = activeProvider
): Promise<AiAssistResponse> => {
  return runAiAssistPipelineWithProvider(request, provider, {
    onAudit: logAiUsage,
    onProviderError: (error) => {
      console.error("[ask:ai] provider failed", error);
    }
  });
};
