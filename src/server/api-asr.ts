/**
 * Cloud speech recognition through any OpenAI-compatible transcription endpoint (POST <base>/audio/transcriptions,
 * multipart form with the audio file), such as OpenAI, Groq, SiliconFlow or a self-hosted server. Used by the standalone
 * server only when the person configures a transcription model; the key is sent to that endpoint and nowhere else.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ApiAsrConfig = { baseUrl: string; key: string; model: string; timeoutMs?: number };
export type ApiAsrInput = { file: string; language: string; hotwords: string[]; context: string };

/**
 * The prompt is worded like the local recogniser's term list, so a quiet chunk that echoes it back is removed by the same
 * filter. Only the terms are sent: the previous segment would be echoed just as easily and cannot be told apart from speech.
 */
export function apiAsrPrompt(language: string, hotwords: string[]): string {
  const words = [...new Set(hotwords.map(word => word.trim()).filter(Boolean))].slice(0, 40);
  if (!words.length) return "";
  return language === "en" ? "Terms that may appear: " + words.join(", ") + "." : "会议中可能出现的词：" + words.join("、") + "。";
}

/** Config from the environment, or null when no transcription model is set (then only the local recogniser is used). */
export function apiAsrConfig(env: Record<string, string | undefined>): ApiAsrConfig | null {
  const model = (env.MEETING_ASR_MODEL || "").trim();
  if (!model) return null;
  const baseUrl = (env.MEETING_ASR_BASE_URL || env.MEETING_LLM_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("MEETING_ASR_BASE_URL 必须是 https 地址（本机地址除外）");
  return { baseUrl, key: (env.MEETING_ASR_API_KEY || env.MEETING_LLM_API_KEY || env.OPENAI_API_KEY || "").trim(), model, timeoutMs: Number(env.MEETING_ASR_TIMEOUT_MS) || 60000 };
}

/** A recogniser for one segment at a time; throws on any failure so the caller falls back to the local recogniser. */
export function apiTranscriber(config: ApiAsrConfig, fetchFn: typeof fetch = fetch) {
  return async (input: ApiAsrInput): Promise<{ text: string; model: string }> => {
    const form = new FormData();
    form.append("file", new Blob([await readFile(input.file)], { type: "audio/wav" }), path.basename(input.file));
    form.append("model", config.model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (input.language && input.language !== "auto") form.append("language", input.language);
    const prompt = apiAsrPrompt(input.language, input.hotwords);
    if (prompt) form.append("prompt", prompt);
    let response: Response;
    try {
      response = await fetchFn(config.baseUrl + "/audio/transcriptions", { method: "POST", body: form, signal: AbortSignal.timeout(config.timeoutMs ?? 60000),
        headers: config.key ? { authorization: "Bearer " + config.key } : {} });
    } catch (error) { throw Error(error instanceof Error && error.name === "TimeoutError" ? "语音识别接口超时" : "语音识别接口请求失败"); }
    if (!response.ok) throw Error("语音识别接口返回错误（HTTP " + response.status + "）");
    const body = await response.json().catch(() => null) as { text?: unknown } | null;
    if (!body || typeof body.text !== "string") throw Error("语音识别接口返回了无法解析的结果");
    return { text: body.text.trim(), model: config.model };
  };
}

