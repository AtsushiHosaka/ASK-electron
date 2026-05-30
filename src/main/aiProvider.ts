import type { AiProvider, AiProviderRequest, AiProviderResult } from "../shared/aiPipeline";

const taskTitles: Record<AiProviderRequest["task"], string> = {
  question_rewrite: "質問文の整理案",
  error_summary: "エラー要約",
  cause_candidates: "原因候補と次の確認",
  patch_proposal: "レビュー用パッチ案"
};

const taskBodies: Record<AiProviderRequest["task"], string> = {
  question_rewrite:
    "状況、期待した結果、実際の結果、先生に確認してほしい点を分けて書くと伝わりやすくなります。",
  error_summary:
    "重要なログ、直前に実行した操作、再現条件を残し、重複した stack trace や環境固有のノイズは省いてください。",
  cause_candidates:
    "依存関係、設定値、認証状態、ローカル環境差分を順に確認してください。危険な操作は先生の確認後に進めてください。",
  patch_proposal:
    "この出力はレビュー用の提案です。適用は学生の明示確認と patch review フローを通してください。"
};

const summarizeContext = (request: AiProviderRequest): string => {
  if (request.context.length === 0) {
    return "- 追加コンテキストなし";
  }

  return request.context
    .slice(0, 6)
    .map((entry) => {
      const suffix = entry.truncated ? " / truncated" : "";
      return `- ${entry.label}: ${entry.kind}, ${entry.valueChars} chars${suffix}`;
    })
    .join("\n");
};

const clipOutput = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
};

const buildMockResponse = (request: AiProviderRequest): string => {
  const text = [
    `## ${taskTitles[request.task]}`,
    taskBodies[request.task],
    "",
    "### 利用した最小コンテキスト",
    summarizeContext(request),
    "",
    "### 注意",
    "AI 出力は提案です。コードの実行、ローカル適用、秘密情報を含む再送信は行っていません。"
  ].join("\n");

  return clipOutput(text, request.options.maxOutputChars);
};

export const createMockAiProvider = (): AiProvider => ({
  id: "mock-safe-local",
  mode: "mock",
  supportsStreaming: false,
  generate: async (request): Promise<AiProviderResult> => {
    const text = buildMockResponse(request);

    return {
      text,
      usage: {
        inputChars: request.prompt.system.length + request.prompt.user.length,
        outputChars: text.length
      }
    };
  }
});
