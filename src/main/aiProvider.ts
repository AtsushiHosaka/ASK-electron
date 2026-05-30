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
  cause_candidates: [
    "以下は断定ではない調査開始用の候補です。",
    "",
    "1. 確度: 中 / 依存関係やlockfile差分の影響",
    "   根拠: Git差分、環境情報、実行コマンドに変更点がある場合に起きやすいです。",
    "   次に確認: `npm install` の直後差分、`package.json`、lockfile、実行ログ。",
    "",
    "2. 確度: 中 / 設定値または環境変数の不足",
    "   根拠: ローカルでは再現しやすく、別環境では通るケースがあります。",
    "   次に確認: `.env.example`、起動時ログ、必要な公開設定名。秘密値そのものは送信しないでください。",
    "",
    "3. 確度: 低 / 入力値や状態遷移の想定漏れ",
    "   根拠: エラー文だけでは断定できないため、再現手順と対象ファイルの確認が必要です。",
    "   次に確認: エラー発生直前の操作、関連ファイル、最小再現手順。"
  ].join("\n"),
  patch_proposal: JSON.stringify(
    {
      target_file_path: "src/example.ts",
      base_commit_sha: null,
      explanation: "入力値が空の場合でも安全に数値化できるように、変換前のデフォルト値を補います。",
      patch_text: [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,3 +1,3 @@",
        "-const value = Number(input.value);",
        "+const value = Number(input.value || 0);"
      ].join("\n")
    },
    null,
    2
  )
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
