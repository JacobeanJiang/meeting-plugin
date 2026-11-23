import type { Settings } from "../shared";

/** Whisper decoding hints per language; the vocabulary the person entered is appended so names and jargon come out right. */
const PROMPT: Record<Settings["language"], { simplified: string; traditional: string }> = {
  zh: { simplified: "以下是一段普通话会议讨论的记录，使用简体中文，带标点。", traditional: "以下是一段會議討論的記錄，使用繁體中文，帶標點。" },
  auto: { simplified: "以下是一段会议记录，可能夹杂中文和英文，中文使用简体。", traditional: "以下是一段會議記錄，可能夾雜中文和英文，中文使用繁體。" },
  en: { simplified: "The following is a transcript of a work meeting, with punctuation.", traditional: "The following is a transcript of a work meeting, with punctuation." },
  ja: { simplified: "以下は会議の議事録です。句読点を付けます。", traditional: "以下は会議の議事録です。句読点を付けます。" },
  ko: { simplified: "다음은 회의 녹취록입니다.", traditional: "다음은 회의 녹취록입니다." },
};
export const VAD: Record<Settings["vad"], { threshold: number; minMs: number }> = { strict: { threshold: 0.6, minMs: 250 }, standard: { threshold: 0.5, minMs: 150 }, loose: { threshold: 0.35, minMs: 80 } };

export function vocabularyTerms(vocabulary: string): string[] {
  return [...new Set(vocabulary.split(/[,，、;；\n]+/).map(term => term.trim()).filter(Boolean))].slice(0, 40);
}
export function asrPrompt(settings: Settings, assistantName = "AI 助手"): string {
  const base = PROMPT[settings.language][settings.script === "traditional" ? "traditional" : "simplified"];
  const terms = vocabularyTerms(settings.vocabulary);
  // The name people use to hand work to the assistant; spelled right, it is far easier to recognise a request.
  if (settings.aiTasks !== false && (settings.language === "zh" || settings.language === "auto") && !terms.includes(assistantName)) terms.unshift(assistantName);
  if (!terms.length) return base;
  return base + (settings.language === "en" ? " Terms that may appear: " + terms.join(", ") + "." : "会议中可能出现的词：" + terms.join("、") + "。");
}
/** A minimal local-only voxtype config: never inherits post-process hooks, remote ASR or dictation output. */
/** Short hint used to retry a chunk Whisper broke mid-character; the long hint plus vocabulary sometimes triggers that. */
export const RETRY_PROMPT = "以下是普通话的句子。";

/** Characters that carry no words: spaces, punctuation and symbols. Matching ignores them, so "词:AI 助手." matches "词：AI 助手。". */
const SEPARATOR = /[\s\p{P}\p{S}]/u;
/** The text without separators, lower-cased, with the position in the original text of every kept character. */
function compact(text: string): { value: string; at: number[] } {
  let value = ""; const at: number[] = [];
  [...text].reduce((offset, char) => { if (!SEPARATOR.test(char)) { value += char.toLowerCase(); at.push(offset); } return offset + char.length; }, 0);
  return { value, at };
}
/**
 * The pieces of a recognition prompt that Whisper may write back as a transcript. In the term list ("会议中可能出现的词：AI 助手。")
 * a piece must reach back at least to the label before the colon ("词：AI 助手"), so a name said on its own is never taken for an
 * echo. In other sentences a piece is the end of the sentence, at least six characters long. Longest first.
 */
function echoPieces(prompts: string[]): { text: string; labelled: boolean }[] {
  const pieces = new Map<string, boolean>();
  for (const prompt of prompts) {
    for (const sentence of prompt.split(/(?<=[。.!?！？])/)) {
      const colon = Math.max(sentence.lastIndexOf("："), sentence.lastIndexOf(":"));
      if (colon >= 0) {
        const label = [...compact(sentence.slice(0, colon)).value], terms = compact(sentence.slice(colon + 1)).value;
        if (!terms) continue;
        for (let start = 0; start < label.length; start++) pieces.set(label.slice(start).join("") + terms, true);
      } else {
        const words = [...compact(sentence).value];
        for (let start = 0; start + 6 <= words.length; start++) if (!pieces.has(words.slice(start).join(""))) pieces.set(words.slice(start).join(""), false);
      }
    }
  }
  return [...pieces].map(([text, labelled]) => ({ text, labelled })).sort((a, b) => b.text.length - a.text.length);
}
/**
 * Whisper reads its prompt as words said just before the segment. On a chunk without clear speech it often writes the end of
 * the prompt back out ("词：AI 助手。"), sometimes repeated, around real speech or in the middle of it. Removes echoes at the
 * start and the end of a transcript, and term-list echoes that end a sentence anywhere in it. When an echo was found and at
 * most three characters are left ("这些", "请问您"), the chunk had no real speech and the result is empty.
 */
export function stripPromptEcho(text: string, prompts: string[]): string {
  const pieces = echoPieces(prompts.filter(Boolean));
  let value = text.trim();
  let found = false;
  for (let changed = true; changed && value;) {
    changed = false;
    const { value: flat, at } = compact(value);
    for (const piece of pieces) {
      const index = flat.indexOf(piece.text);
      if (index < 0) continue;
      const last = at[index + piece.text.length - 1];
      const end = last + [...value.slice(last)][0].length;
      const atEdge = index === 0 || index + piece.text.length === flat.length;
      if (!atEdge && !(piece.labelled && /^\s*[。.!！?？]/u.test(value.slice(end)))) continue;
      const before = value.slice(0, at[index]).replace(/[\s，,、：:；;]+$/u, "");
      const after = value.slice(end).replace(/^[\s\p{P}\p{S}]+/u, "");
      // An echo between two sentences took the full stop with it; put one back so they do not run together.
      const join = before && after && !/[\p{P}]$/u.test(before) ? "。" : "";
      value = (before + join + after).trim(); changed = true; found = true; break;
    }
  }
  return found && [...compact(value).value].length <= 3 ? "" : value;
}
export function asrConfig(model: string, settings: Settings, vadModel: string | null = null, prompt: string | null = asrPrompt(settings)): string {
  const vad = VAD[settings.vad];
  return "[hotkey]\nenabled = false\n[whisper]\nmode = \"local\"\nmodel = " + JSON.stringify(model) + "\nlanguage = " + JSON.stringify(settings.language) + "\ntranslate = false" + (prompt ? "\ninitial_prompt = " + JSON.stringify(prompt) : "")
    + "\n[output]\nmode = \"clipboard\"\n[vad]\nenabled = true\nbackend = \"whisper\"\nthreshold = " + vad.threshold + "\nmin_speech_duration_ms = " + vad.minMs + "\n" + (vadModel ? "model = " + JSON.stringify(vadModel) + "\n" : "");
}

const KANA = /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]+/g;
/**
 * Cleans what Whisper produces on short, noisy chunks: stray Japanese kana inside Chinese, leading symbol junk,
 * and loops where the same phrase repeats; then normalises Chinese script. Returns the original text if nothing applies.
 */
export async function polishTranscript(text: string, settings: Settings, convert: (text: string, to: "Hans" | "Hant") => Promise<string>): Promise<string> {
  let value = text;
  const chinese = settings.language === "zh" || settings.language === "auto";
  if (settings.cleanup) {
    if (chinese) value = value.replace(KANA, "");
    value = value.replace(/^[\s~!@#$%^&*_=+|\\<>`·…]+/u, "");
    value = value.replace(/(.{4,40}?[。！？!?；;，,]?)\1{2,}/gu, "$1"); // the same sentence three times or more
    value = value.replace(/(.{1,6}?[、，, ]?)\1{2,}/gu, "$1"); // 会议助手、会议助手、会议助手、会议助手
    value = value.replace(/[ \t]{2,}/g, " ").trim();
  }
  if (chinese && settings.script !== "original" && /\p{Script=Han}/u.test(value)) {
    try { value = await convert(value, settings.script === "traditional" ? "Hant" : "Hans"); } catch { /* keep the recognised text */ }
  }
  return value.trim();
}
