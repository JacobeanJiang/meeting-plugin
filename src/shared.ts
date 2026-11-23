export type Settings = {
  binaryPath: string; model: string | null; autoSummary: boolean; chunkSecs: number;
  /** Recognition: installed Whisper model (null follows voxtype), spoken language, Chinese script, terms to bias towards, silence filter, cleanup. */
  asrModel: string | null; language: "zh" | "en" | "ja" | "ko" | "auto"; script: "simplified" | "traditional" | "original"; vocabulary: string; vad: "strict" | "standard" | "loose"; cleanup: boolean;
  /** Board form for new meetings; "auto" lets the organiser judge it. */
  defaultForm: "auto" | "topics" | "mindmap" | "flow" | "matrix" | "status";
  /** Requests addressed to AI 助手 during a meeting are carried out in the background and shown on the meeting page. */
  aiTasks: boolean;
  /** After recognition, an AI model proofreads each caption (misheard words, punctuation, fillers); the recognised text is kept. */
  rewrite: boolean;
  /** Model for proofreading; null uses the platform's default model. */
  rewriteModel: string | null;
  /** Speech recognition: the host's cloud recogniser (falls back to this computer when it fails) or this computer only. */
  asrEngine: "cloud" | "local";
  /** Situations the person describes in their own words; when the meeting gets there, the assistant does the work they set, without being named. */
  scenarios: Scenario[];
};
/** "when" the discussion matches, "action" what to do; confirm: wait for the person on the meeting page before carrying it out. */
export type Scenario = { id: string; when: string; action: string; confirm: boolean; enabled: boolean };
export const SCENARIO_LIMIT = 8;
export const SCENARIO_TEXT_LIMIT = 200;
/** Starting points offered when no scenario is set yet. */
export const SCENARIO_EXAMPLES: { when: string; action: string }[] = [
  { when: "会上提到线上问题、报错或 bug", action: "整理问题现象、影响范围和复现线索，写成一条可以直接提交的缺陷描述" },
  { when: "有人问到具体数据，但会上没人能马上回答", action: "查询相关数据，给出结论和数据来源" },
  { when: "会上定下了待办和负责人", action: "整理成待办清单：事项、负责人、截止时间" },
];
export const DEFAULT_SETTINGS: Settings = { binaryPath: "", model: null, autoSummary: true, chunkSecs: 15, asrModel: null, language: "zh", script: "simplified", vocabulary: "", vad: "standard", cleanup: true, defaultForm: "mindmap", aiTasks: true, rewrite: true, rewriteModel: null, asrEngine: "cloud", scenarios: [] };
export type Segment = {
  id: string; seq: number; startMs: number; endMs: number;
  status: "pending" | "transcribing" | "done" | "empty" | "failed";
  text: string; error: string | null;
  /** Set by the organiser for small talk unrelated to the meeting; shown faded, never put on the board. */
  tag: "chatter" | null;
  /** What speech recognition produced, when the caption text was proofread by the model; null otherwise (missing on older records). */
  raw?: string | null;
  /** Proofreading of this caption: waiting, done (text replaced), kept (the correction was rejected) or failed. */
  rewrite?: "pending" | "done" | "kept" | "failed" | null;
};
export type Note = { kind: "point" | "decision" | "action" | "question"; topic: string; text: string; segmentIds: string[]; quote: string; owner: string | null; due: string | null };
export const DEFAULT_TOPIC = "综合讨论";
export type BoardForm = "topics" | "mindmap" | "flow" | "matrix" | "status";
export const BOARD_FORMS: BoardForm[] = ["topics", "mindmap", "flow", "matrix", "status"];
export const FORM_LABEL: Record<BoardForm, string> = { topics: "议题分区", mindmap: "思维导图", flow: "流程线", matrix: "方案对比", status: "进度看板" };
/**
 * How much room the board has on the screens showing it. "compact" (a narrow page or side panel) gets a narrower layout,
 * fewer cards per topic and shorter wording from the organiser, so the board stays readable without zooming out.
 */
export type BoardSpace = "compact" | "normal";
/** The model's judgement of what the meeting is about and which board form fits it. */
export type MeetingPlan = { theme: string; center: string; type: string; form: BoardForm; reason: string; decidedAt: number; lockedBy: "model" | "user"; pendingForm: BoardForm | null; pendingCount: number };
export type ItemKind = "point" | "proposal" | "risk" | "decision" | "action" | "question" | "step" | "status" | "cell";
export const ITEM_KINDS: ItemKind[] = ["point", "proposal", "risk", "decision", "action", "question", "step", "status", "cell"];
export type LinkType = "causes" | "supports" | "opposes" | "resolves" | "leads_to" | "depends";
export const LINK_TYPES: LinkType[] = ["causes", "supports", "opposes", "resolves", "leads_to", "depends"];
export const STATUS_GROUPS = ["已完成", "进行中", "受阻", "下一步"];
export const SIDE_GROUP = "要点";
/**
 * One entry on the board. Entries are append-only and keep their id, so the board never jumps:
 * the organiser may only add entries, link them, or revise at most a couple per round with a reason.
 */
export type BoardItem = { id: string; group: string; kind: ItemKind; text: string; refs: string[]; owner: string | null; due: string | null; criterion: string | null; createdAt: number; updatedAt: number; previous: string | null;
  /** Subtopic inside the group (for topics and mind maps); discussion with the same subtopic is shown as one compact block. */
  sub: string | null;
  /** Hidden when its topic was wrapped up: a detail the closing summary already covers. Kept for Q&A and export. */
  folded?: boolean };
/**
 * Topics as chapters of the meeting. The organiser reports which topic the new speech is about; when it moves on and the
 * next round confirms it, the previous topic is wrapped up once (final summary, fine details folded) and then frozen.
 */
export type Chapters = { active: string | null; closing: string | null; closed: string[] };
export const NO_CHAPTERS: Chapters = { active: null, closing: null, closed: [] };
/** One line per group saying where that part of the meeting stands; the organiser keeps it current. */
export type GroupSummary = { group: string; text: string; refs: string[]; updatedAt: number; previous: string | null };
export type BoardLink = { id: string; from: string; to: string; type: LinkType; label: string | null };
export type RoundChange = { at: number; added: number; revised: number; linked: number; rebuilt: boolean };
export type Meeting = {
  id: string; title: string; startedAt: number; endedAt: number | null;
  phase: "starting" | "recording" | "paused" | "stopping" | "complete" | "interrupted";
  segments: Segment[]; notes: Note[]; summaryThrough: number; summaryAt: number | null;
  summaryState: "idle" | "working" | "failed"; summaryError: string | null;
  error: string | null; plan: MeetingPlan | null; items: BoardItem[]; links: BoardLink[]; summaries: GroupSummary[]; lastChange: RoundChange | null;
  /** Missing on meetings recorded before chapters existed. */
  chapters?: Chapters | null;
  /** A form the person asked for that is being redrawn; the board keeps showing plan.form until it is ready. */
  requestedForm: BoardForm | null;
  /** Set when a new meeting was started from this one, so a conversation holding this id can follow to the new record. */
  nextMeetingId?: string | null;
  /** Work requested of AI 助手 during this meeting, and the background conversation that carries it out. */
  aiTasks?: AiTask[];
  aiSessionId?: string | null;
  /** The conversation people use to talk about this meeting (the one that started it, or one opened from the meeting page). */
  chatSessionId?: string | null;
  /** Project of the conversation that started the meeting; background work runs there. */
  workspaceId?: string | null;
  /** Whole-meeting minutes written with the product minutes prompt (Markdown), and how far the transcript was covered. */
  minutes?: Minutes | null;
  /** Progress of redrawing the whole board in a requested form, replayed window by window. */
  redraw?: { done: number; total: number } | null;
};
export type Minutes = { markdown: string | null; at: number | null; through: number; state: "idle" | "working" | "failed"; error: string | null; model: string | null };
/** One request to AI 助手 heard in the meeting: queued, carried out in the background conversation, then its result or failure. */
/**
 * confirm: proposed by a scenario that waits for the person; skipped: the person declined it.
 * scenario: the situation ("when") that raised it, as set at the time; absent for requests naming the assistant.
 */
export type AiTask = { id: string; instruction: string; quote: string; refs: string[]; status: "confirm" | "queued" | "running" | "done" | "failed" | "skipped"; createdAt: number; startedAt: number | null; finishedAt: number | null; result: string | null; error: string | null; turnId: string | null; scenario?: string | null };
/** Recognition model preparation, done automatically after install: checking, downloading with progress, ready, or failed with a reason. */
export type Setup = { status: "checking" | "downloading" | "ready" | "failed"; model: string; received: number; total: number; error: string | null };
export type Snapshot = { settings: Settings; meeting: Meeting | null; levelDbfs: number | null; pending: number; history: { id: string; title: string; startedAt: number; phase: string; theme: string }[]; setup: Setup };
export type Environment = { supported: boolean; binary: string | null; version: string | null; error: string | null; asrModels: string[]; defaultAsrModel: string | null; setup: Setup; asrChoices: { name: string; label: string }[]; cloudAsr?: boolean };
/** Models the plugin downloads by itself, for the settings menus. */
export const ASR_CHOICES: { name: string; label: string }[] = [{ name: "large-v3-turbo-q5_0", label: "推荐 · 574MB" }, { name: "large-v3-turbo", label: "更准 · 1.6GB" }, { name: "small", label: "较快 · 488MB" }];
/** Windows recognises on the CPU: small keeps up with a live meeting, the large models need a fast processor. */
export const WINDOWS_ASR_CHOICES: { name: string; label: string }[] = [{ name: "small", label: "推荐 · 488MB，普通电脑也能跟上" }, { name: "large-v3-turbo-q5_0", label: "更准但慢 · 574MB，需要较强的处理器" }, { name: "large-v3-turbo", label: "最准最慢 · 1.6GB" }];
export const asrChoicesFor = (platform: string) => platform === "win32" ? WINDOWS_ASR_CHOICES : ASR_CHOICES;
export function setupText(setup: Setup | null | undefined): string | null {
  if (!setup || setup.status === "ready") return null;
  if (setup.status === "failed") return setup.error ?? "识别模型准备失败";
  if (setup.status === "downloading" && setup.total) return "正在下载识别模型 " + Math.floor(setup.received / setup.total * 100) + "%（" + Math.round(setup.received / 1048576) + "/" + Math.round(setup.total / 1048576) + "MB），可以先开始录音，下载完成后自动转写";
  return "正在准备识别模型…";
}
export function stamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
export function markdown(meeting: Meeting): string {
  const lines = ["# " + meeting.title, "", "开始：" + new Date(meeting.startedAt).toLocaleString(), "", "摘要覆盖至第 " + (meeting.summaryThrough + 1) + " 段；识别和 AI 整理均需核对。", ""];
  for (const [kind, label] of [["point", "讨论重点"], ["decision", "会议结论"], ["action", "行动待办"], ["question", "待确认"]]) {
    lines.push("## " + label, "");
    const items = meeting.notes.filter(note => note.kind === kind);
    for (const note of items) lines.push("- 【" + note.topic + "】" + note.text + (kind === "action" ? "（负责人：" + (note.owner ?? "待确认") + "；截止：" + (note.due ?? "待确认") + "）" : "") + " [" + note.segmentIds.join(", ") + "]", "  依据：" + note.quote);
    if (!items.length) lines.push("暂无已整理内容。");
    lines.push("");
  }
  lines.push("## 转写原文", "");
  for (const segment of meeting.segments) if (segment.status !== "empty") lines.push("[" + stamp(segment.startMs) + " · " + segment.id + "] " + (segment.status === "done" ? segment.text : "（" + (segment.error ?? "尚未转写") + "）"), "");
  return lines.join("\n");
}

/** Footnote number for a transcript segment: its position in the recording, stable for the whole meeting. */
export const footnote = (segmentId: string) => Number(segmentId.slice(1)) + 1;
