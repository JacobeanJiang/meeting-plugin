import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asrChoicesFor, type AiTask, BOARD_FORMS, DEFAULT_SETTINGS, DEFAULT_TOPIC, FORM_LABEL, markdown, type BoardForm, type Settings, type Meeting, type Snapshot, type Environment, type Segment } from "../shared";
import { RETRY_PROMPT, VAD, asrConfig, asrPrompt, polishTranscript } from "./asr";
import * as OpenCC from "opencc-js";
import { ModelStore, WINDOWS_DEFAULTS, type SetupState } from "./models";
import { DEFAULT_ASSISTANT, detectTasks, mentionsAssistant, quickTasks, taskMessage, type Assistant } from "./tasks";
import { generateMinutes } from "./minutes";
import { minutesDocument, minutesMeta } from "../minutes-format";
import { applyRound, itemsFromNotes, meaningfulLength, mergePlan, notesFromItems, summarize, type Generate } from "./summary";

/** Listen before drawing: the first judgement waits for this much meaningful speech; after five minutes a form is chosen regardless. */
export const LISTEN_FIRST_CHARS = 120;
/** Segments added per model call when a whole meeting is redrawn; keeps every call well inside the host limit on one model request. */
export const REDRAW_WINDOW = 12;
/** Minutes need real discussion: a few stray words (or noise read as words) would be dressed up as a made-up meeting. */
export const MINUTES_MIN_CHARS = 60;
export const MUST_DECIDE_AFTER_MS = 300000;


type Stored = Meeting & { asrModel: string; audioFiles: Record<string, string>; sessionDir: string };
export type Recorder = { write: (command: string) => void; kill: () => void };
export type Deps = {
  data: string; temp: string; recorderPath: string; generate: Generate;
  /** voxtype shipped inside the plugin; used unless the person points to another one. */
  voxtypePath?: string;
  /** Windows: bundled whisper-cli builds, fastest first; a build the processor cannot run is skipped. */
  whisperPaths?: string[];
  /** Recognition models; defaults to a store in the plugin data folder that downloads what is missing. */
  models?: Pick<ModelStore, "state" | "ensure" | "locate" | "vad" | "installed" | "preferred">;
  emit: (snapshot: Snapshot) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  platform?: string;
  run?: (binary: string, args: string[], cwd?: string) => Promise<string>;
  record?: (dir: string, seconds: number, event: (value: Record<string, unknown>) => void, ended: (code: number | null) => void) => Recorder;
  /** Background conversations for work requested of AI 助手; absent when the host cannot start them. */
  sessions?: { start: (workspaceId: string) => Promise<string>; send: (workspaceId: string, sessionId: string, message: string) => Promise<string>; status: (workspaceId: string, sessionId: string, turnId: string) => Promise<string>; workspace: () => Promise<string | null>;
    /** "output": the run's final answer is the result (agents run from the command line); "tool" (default): the run reports through submit_task_result. */
    reply?: "tool" | "output"; output?: (turnId: string) => Promise<string | null> };
  /** Who people address during the meeting to hand over work; defaults to AI 助手. */
  assistant?: Assistant;
  /** Without an organising model, take the speech naming the assistant as the task, worded as said. */
  quickTasks?: boolean;
  /** Seconds between status checks of a running task (tests shorten it). */
  taskPollMs?: number;
  /** Chinese script conversion; defaults to the bundled recorder in text mode. */
  convert?: (text: string, to: "Hans" | "Hant") => Promise<string>;
};
export function parseTranscript(output: string): string {
  if (/No speech detected, skipping transcription\./.test(output)) return "";
  // v1.2.2's CLI prints diagnostics followed by a blank line and then the transcript.
  const match = output.match(/Processing \d+ samples \([\d.]+s\)\.\.\.[\s\S]*?\n\s*\n([\s\S]*)$/);
  if (!match) throw Error("无法解析 voxtype 输出，请确认使用 v1.2.2 兼容版本");
  const text = match[1].trim();
  return isNoiseTranscript(text) ? "" : text;
}
/** Whisper fills silence with stock phrases learned from subtitled videos; those are not speech. */
const NOISE_PATTERNS = [/字幕(由|提供|制作|製作|组|組|by)/i, /(不吝)?(点赞|點讚|點贊)(订阅|訂閱|转发|轉發)/, /明镜与点点|明鏡與點點/, /优优独播|優優獨播/, /amara\.?org/i,
  /^(谢谢|謝謝)(观看|觀看|收看|收听|收聽)$/, /^(中文)?(字幕|字幕组)$/, /^(请|請)?(订阅|訂閱)(我的)?(频道|頻道)$/];
export function isNoiseTranscript(text: string): boolean {
  const compact = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return !compact || compact.length <= 40 && NOISE_PATTERNS.some(pattern => pattern.test(compact));
}
function convertWith(recorder: string): (text: string, to: "Hans" | "Hant") => Promise<string> {
  return (text, to) => new Promise((resolve, reject) => {
    const child = spawn(recorder, ["--convert", to === "Hant" ? "Hans-Hant" : "Hant-Hans"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; const timer = setTimeout(() => { child.kill("SIGTERM"); reject(Error("timeout")); }, 5000);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 && out ? resolve(out) : reject(Error("convert failed")); });
    child.stdin.on("error", () => undefined); child.stdin.end(text);
  });
}
/** Whisper occasionally cuts a Chinese character in half and voxtype refuses the result; a retry with a shorter hint usually avoids it. */
export const INVALID_UTF8 = "INVALID_UTF8";
/** Chinese script conversion on Windows, where there is no system transform to borrow. */
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" }), toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });
export const convertOpenCC = async (text: string, to: "Hans" | "Hant") => to === "Hant" ? toTraditional(text) : toSimplified(text);
function runDefault(binary: string, args: string[], onChild?: (child: ChildProcess) => void, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    // This plugin always uses a local generated config and strips all inherited VOXTYPE overrides.
    for (const key of Object.keys(env)) if (key.startsWith("VOXTYPE_")) delete env[key];
    const child = execFile(binary, args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024, env, windowsHide: true, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => error ? reject(Error(/Invalid UTF-8/.test(String(stdout) + String(stderr)) ? INVALID_UTF8 : "本机转写失败，请检查语音模型或重试")) : resolve(stdout));
    onChild?.(child);
  });
}
export class MeetingController {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private current: Stored | null = null;
  private records = new Map<string, Stored>();
  private recorder: Recorder | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saves: Promise<unknown> = Promise.resolve();
  private processing = false;
  private disposed = false;
  private summarizing = false;
  private summaryToken = 0;
  private relayoutPending = false;
  private level: number | null = null;
  private recorderReady = false;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private transcriptionChildren = new Set<ChildProcess>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private configFile = "";
  private configFor = "";
  private readonly models: NonNullable<Deps["models"]>;
  private get assistant(): Assistant { return this.deps.assistant ?? DEFAULT_ASSISTANT; }
  constructor(private readonly deps: Deps) {
    this.models = deps.models ?? (this.platform === "win32" ? new ModelStore(path.join(deps.data, "models"), () => this.emit(), fetch, null, WINDOWS_DEFAULTS) : new ModelStore(path.join(deps.data, "models"), () => this.emit()));
  }
  private get platform(): string { return this.deps.platform ?? process.platform; }
  private get windows(): boolean { return this.platform === "win32"; }
  private whisper: { path: string; version: string } | null = null;
  /** Gets the recognition model ready in the background; recording does not wait for it. */
  private prepare(): void {
    if (!["darwin", "win32"].includes(this.platform) || this.disposed) return;
    void this.models.preferred(this.settings.asrModel).then(name => this.models.ensure(name)).then(() => { this.emit(); if (this.current?.segments.some(segment => segment.status === "pending")) void this.drain().catch(() => undefined); }).catch(() => this.emit());
  }
  retrySetup(): Snapshot { this.prepare(); return this.snapshot(); }
  private run(binary: string, args: string[], cwd?: string) {
    if (this.deps.run) return this.deps.run(binary, args, cwd);
    return runDefault(binary,args,child=>{this.transcriptionChildren.add(child);child.once("exit",()=>this.transcriptionChildren.delete(child));child.once("error",()=>this.transcriptionChildren.delete(child));},cwd);
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> { const next = this.queue.then(task, task); this.queue = next.catch(() => undefined); return next; }
  async initialize(): Promise<void> {
    await mkdir(path.join(this.deps.data, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(this.deps.temp, { recursive: true, mode: 0o700 });
    try { const raw = JSON.parse(await readFile(path.join(this.deps.data, "settings.json"), "utf8")); this.settings = this.normalizeSettings(raw); } catch { /* first launch */ }
    for (const name of await readdir(path.join(this.deps.data, "sessions"))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.deps.data, "sessions", name), "utf8")) as Stored;
        if (!record.id || !Array.isArray(record.segments) || !record.audioFiles) continue;
        if (["starting", "recording", "paused", "stopping"].includes(record.phase)) {
          record.phase = "interrupted"; record.error = "上次录音已中断，已有转写保留；可重试尚未转写的音频。";
        }
        for (const segment of record.segments) if (["pending", "transcribing"].includes(segment.status)) { segment.status = "failed"; segment.error = "上次处理被中断，可重试"; }
        for (const segment of record.segments) if (segment.status === "done" && isNoiseTranscript(segment.text)) { segment.status = "empty"; segment.text = ""; }
        record.summaryState = "idle";
        record.asrModel ||= "large-v3-turbo";
        record.notes = Array.isArray(record.notes) ? record.notes.map(note => ({ ...note, topic: note.topic || DEFAULT_TOPIC })) : [];
        // Older meetings: segments gain the chatter tag, plans a centre, and organised notes become board entries in the same groups.
        for (const segment of record.segments) segment.tag ??= null;
        if (record.plan === undefined) record.plan = record.notes.length ? { theme: "", center: "", type: "other", form: "topics", reason: "沿用旧版议题整理", decidedAt: record.summaryAt ?? record.startedAt, lockedBy: "model", pendingForm: null, pendingCount: 0 } : null;
        if (record.plan) record.plan.center ??= record.plan.theme.slice(0, 16);
        if (!Array.isArray(record.items)) record.items = itemsFromNotes(record.notes, record.summaryAt ?? record.startedAt);
        if (!Array.isArray(record.links)) record.links = [];
        record.lastChange ??= null;
        record.summaries ??= [];
        record.minutes ??= null; if (record.minutes?.state === "working") record.minutes = { ...record.minutes, state: "failed", error: "会议助手重启时纪要还没生成完，请重新生成" };
        record.chapters ??= null; record.nextMeetingId ??= null; record.aiTasks ??= []; record.aiSessionId ??= null; record.workspaceId ??= null;
        for (const task of record.aiTasks) if (task.status === "running" || task.status === "queued") Object.assign(task, { status: "failed", error: "服务重启时任务还没完成，可以在会上重新请" + this.assistant.name + "做一次", finishedAt: task.finishedAt ?? Date.now() });
        for (const item of record.items) item.sub ??= null;
        record.requestedForm = null; record.redraw = null; // a redraw interrupted by a restart is simply not resumed
        record.summaryError = null; // an organising failure from an earlier run is no longer actionable; the board it kept is still there
        // Topic boards the model chose earlier carry the same ledger (topic -> viewpoints), so they are shown as mind maps.
        if (record.plan && record.plan.lockedBy !== "user" && record.plan.form === "topics") record.plan = { ...record.plan, form: "mindmap", center: record.plan.center || record.plan.theme.slice(0, 16), reason: "统一为思维导图", pendingForm: null, pendingCount: 0 };
        delete (record as { view?: unknown }).view;
        this.records.set(record.id, record);
      } catch { /* a corrupt record cannot block other history */ }
    }
    this.current = [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    if (!this.windows) for (const file of [this.deps.voxtypePath, this.deps.recorderPath]) if (file && !this.deps.record) await chmod(file, 0o700).catch(() => undefined);
    this.prepare();
    // Background organising only follows a meeting that is still running; ended or interrupted meetings are organised on request.
    this.tick = setInterval(() => { if (!this.disposed && this.settings.autoSummary && this.isActive()) void this.doSummary(false).catch(() => undefined); }, 45000);
    this.tick.unref();
  }
  private normalizeSettings(value: unknown): Settings {
    const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const pick = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(raw as T) ? raw as T : fallback;
    return { binaryPath: typeof r.binaryPath === "string" ? r.binaryPath.slice(0, 4096) : "", model: typeof r.model === "string" && r.model ? r.model.slice(0, 256) : null, autoSummary: r.autoSummary !== false, chunkSecs: [10, 15, 30].includes(Number(r.chunkSecs)) ? Number(r.chunkSecs) : 15,
      asrModel: typeof r.asrModel === "string" && /^[\w.-]{1,64}$/.test(r.asrModel) ? r.asrModel : null,
      language: pick(r.language, ["zh", "en", "ja", "ko", "auto"] as const, "zh"), script: pick(r.script, ["simplified", "traditional", "original"] as const, "simplified"),
      vocabulary: typeof r.vocabulary === "string" ? r.vocabulary.slice(0, 500) : "", vad: pick(r.vad, ["strict", "standard", "loose"] as const, "standard"), cleanup: r.cleanup !== false,
      defaultForm: (r.defaultForm === "auto" ? "mindmap" : pick(r.defaultForm, ["topics", "mindmap", "flow", "matrix", "status"] as const, "mindmap")), aiTasks: r.aiTasks !== false };
  }

  private publicMeeting(record: Stored): Meeting { const { audioFiles: _files, sessionDir: _dir, asrModel: _model, ...value } = record; return value; }
  snapshot(record: Stored | null = this.current): Snapshot {
    const meeting = record ? this.publicMeeting(record) : null;
    return structuredClone({ settings: this.settings, meeting, levelDbfs: this.level, pending: record?.segments.filter(segment => ["pending", "transcribing"].includes(segment.status)).length ?? 0, history: [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt).map(({ id, title, startedAt, phase, plan }) => ({ id, title, startedAt, phase, theme: plan?.theme ?? "" })), setup: this.models.state as SetupState });
  }
  view(id: string): Snapshot {
    const record = this.records.get(id);
    if (!record) throw Error("未找到此会议，请从当前会话重新打开");
    return this.snapshot(record);
  }
  private emit() { if (!this.disposed) this.deps.emit(this.snapshot()); }
  private persist(record = this.current): Promise<unknown> {
    if (!record) return Promise.resolve();
    const body = JSON.stringify(record);
    const file = path.join(this.deps.data, "sessions", record.id + ".json");
    const save = this.saves.then(async () => { await writeFile(file + ".tmp", body, { mode: 0o600 }); await rename(file + ".tmp", file); });
    this.saves = save.catch(() => { if (this.current?.id === record.id) { this.current.error = "记录保存失败，请及时复制内容并检查磁盘空间"; this.emit(); } });
    return save;
  }
  private async binary(): Promise<string | null> {
    if (this.windows) return (await this.probeWhisper())?.path ?? null;
    const paths = this.settings.binaryPath ? [this.settings.binaryPath] : [...(this.deps.voxtypePath ? [this.deps.voxtypePath] : []), path.join(os.homedir(), ".local/bin/voxtype"), "/opt/homebrew/bin/voxtype", "/usr/local/bin/voxtype"];
    for (const file of paths) { if (!path.isAbsolute(file)) continue; try { await access(file, constants.X_OK); return file; } catch { /* next */ } }
    return null;
  }
  /** Windows: the first bundled whisper-cli this processor can run (the fast build needs AVX2; the other runs anywhere). */
  private async probeWhisper(): Promise<{ path: string; version: string } | null> {
    if (this.whisper) return this.whisper;
    const paths = this.deps.whisperPaths ?? [];
    for (const [index, file] of paths.entries()) {
      try { await access(file); await this.run(file, ["--help"]); this.whisper = { path: file, version: "whisper.cpp 1.9.5" + (index ? "（兼容模式）" : "") }; return this.whisper; } catch { /* next build */ }
    }
    return null;
  }
  async check(): Promise<Environment> {
    const supported = ["darwin", "win32"].includes(this.platform);
    const binary = await this.binary();
    const setup = this.models.state as SetupState;
    const base = { supported, binary, version: null, asrModels: [] as string[], defaultAsrModel: null as string | null, setup, asrChoices: asrChoicesFor(this.platform) };
    if (!supported) return { ...base, error: "目前只支持 macOS 和 Windows" };
    if (!binary) return { ...base, error: this.windows ? "识别程序无法在这台电脑上运行，请重新安装会议助手" : "会议助手内置的识别程序缺失，请重新安装会议助手" };
    let version: string;
    try { version = this.windows ? this.whisper!.version : (await this.run(binary, ["--version"])).trim().slice(0, 200); }
    catch { return { ...base, error: "识别程序无法运行，请重新安装会议助手" }; }
    return { ...base, version, error: null, asrModels: await this.models.installed(), defaultAsrModel: await this.models.preferred(null) };
  }

  configure(value: unknown): Promise<Snapshot> {
    return this.exclusive(async () => {
      // Settings can change any time: recognition options apply from the next meeting, cleanup, script and organising at once.
      const before = this.settings.asrModel;
      this.settings = this.normalizeSettings(value);
      await writeFile(path.join(this.deps.data, "settings.json"), JSON.stringify(this.settings), { mode: 0o600 });
      if (this.settings.asrModel !== before) this.prepare(); // fetch a newly chosen model right away
      this.emit(); return this.snapshot();
    });
  }
  private isActive() { return this.current && ["starting", "recording", "paused", "stopping"].includes(this.current.phase); }
  private reusable(windowMs: number) { const record = this.current; return Boolean(record && ["starting", "recording", "paused"].includes(record.phase) && Date.now() - record.startedAt <= windowMs); }
  /** Quick-start entry: the composer may already have started this meeting a few seconds earlier. */
  async startOrReuse(title: string, windowMs = 120000, origin?: { workspaceId?: string | null }): Promise<{ snapshot: Snapshot; reused: boolean; ended: { id: string; title: string } | null }> {
    if (this.reusable(windowMs)) { if (origin?.workspaceId && this.current && !this.current.workspaceId) this.current.workspaceId = origin.workspaceId; return { snapshot: this.snapshot(), reused: true, ended: null }; }
    try { const { snapshot, ended } = await this.newMeeting(title, origin); return { snapshot, reused: false, ended }; }
    catch (error) { if (this.reusable(windowMs)) return { snapshot: this.snapshot(), reused: true, ended: null }; throw error; }
  }
  /** Finish the previous meeting before dispatching a new meeting command in its own conversation. */
  async finishForNewMeeting(): Promise<{ id: string; title: string } | null> {
    const previous = this.current; let ended: { id: string; title: string } | null = null;
    if (previous && this.isActive()) {
      ended = { id: previous.id, title: previous.title };
      if (this.recorder && previous.phase !== "stopping") await this.control("stop");
      else if (!this.recorder) await this.exclusive(async () => { previous.phase = "stopping"; await this.maybeFinish(); this.emit(); });
    }
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    for (const deadline = Date.now() + 600000; this.isActive() || this.processing;) { if (Date.now() > deadline) throw Error("上一场会议还在转写最后几段录音，请稍后再开始新会议"); await wait(250); }
    if (ended) for (const deadline = Date.now() + 60000; this.summarizing && Date.now() < deadline;) await wait(250);
    return ended;
  }
  async newMeeting(title: string, origin?: { workspaceId?: string | null }): Promise<{ snapshot: Snapshot; ended: { id: string; title: string } | null }> {
    const previous = this.current;
    const ended = await this.finishForNewMeeting();
    const snapshot = await this.start(title, origin ?? { workspaceId: previous?.workspaceId ?? null });
    if (ended && previous) { previous.nextMeetingId = snapshot.meeting!.id; await this.persist(previous); }
    return { snapshot, ended };
  }
  /** Show another meeting in the page; it becomes the current one unless a meeting is still recording or finishing. */
  async switchTo(id: string): Promise<{ current: boolean }> {
    if (!this.records.has(id)) throw Error("未找到会议");
    if (this.isActive() || this.processing) return { current: this.current?.id === id };
    await this.open(id); return { current: true };
  }
  start(title: string, origin?: { workspaceId?: string | null }): Promise<Snapshot> {
    return this.exclusive(async () => {
      if (this.isActive()) throw Error("已有一场会议正在录音（" + new Date(this.current!.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + " 开始），请先在白板页或会议助手页结束它，再开始新会议");
      if (this.processing) throw Error("上一场会议还在转写最后几段录音，请等几秒再开始");
      // Organising an earlier meeting must never block a new one: its late result is simply dropped.
      if (this.summarizing && this.current) { this.summaryToken++; this.current.summaryState = "idle"; await this.persist(this.current); }
      const env = await this.check();
      if (env.error || !env.binary) throw Error(env.error ?? "环境未就绪");
      if (!this.deps.record && !this.windows) await chmod(this.deps.recorderPath, 0o700);
      const id = randomUUID();
      const sessionDir = path.join(this.deps.data, "audio", id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      this.configFile = path.join(this.deps.temp, id + ".toml");
      const model = await this.models.preferred(this.settings.asrModel);
      this.configFor = ""; // written once the model is on disk, see drain()
      if (this.models.state.status === "failed") this.prepare();
      this.current = { id, title: title.trim().slice(0, 200) || "会议 " + new Date().toLocaleString(), startedAt: Date.now(), endedAt: null, phase: "starting", segments: [], notes: [], summaryThrough: -1, summaryAt: null, summaryState: "idle", summaryError: null, error: null, plan: null, items: [], links: [], summaries: [], lastChange: null, requestedForm: null, chapters: null, nextMeetingId: null, aiTasks: [], aiSessionId: null, minutes: null, redraw: null, workspaceId: origin?.workspaceId ?? null, audioFiles: {}, sessionDir, asrModel: model };
      this.records.set(id, this.current); this.level = null; this.recorderReady = false;
      await this.persist(); this.emit();
      this.startTimeout = setTimeout(() => {
        void this.exclusive(async () => {
          if (this.current?.id !== id || this.recorderReady) return;
          this.current.phase = "interrupted"; this.current.error = "麦克风启动超时，请检查系统麦克风授权后重试";
          this.recorder?.kill(); this.recorder = null; await this.persist(); this.emit();
        }).catch(() => undefined);
      }, 60000);
      this.startTimeout.unref();
      const event = (value: Record<string, unknown>) => { void this.exclusive(() => this.onRecorder(id, value)).catch(() => { if(this.current?.id===id){this.current.error="录音数据保存失败，请停止录音并及时导出";this.emit();} }); };
      const ended = (code: number | null) => { void this.exclusive(async () => {
        if (this.current?.id !== id || this.disposed) return;
        this.recorder = null;
        if (this.current.phase !== "stopping" && this.current.phase !== "complete") { this.current.phase = "interrupted"; this.current.error = code === 0 ? "录音意外结束，已有转写已保留" : this.windows ? "麦克风录音失败：请在 Windows 设置 › 隐私和安全性 › 麦克风 中打开“允许桌面应用访问麦克风”，并确认已连接麦克风" : "麦克风录音失败，请检查系统麦克风权限或设备"; }
        await this.maybeFinish(); this.emit(); await this.persist();
      }).catch(() => undefined); };
      try { this.recorder = this.deps.record ? this.deps.record(sessionDir, this.settings.chunkSecs, event, ended) : this.spawnRecorder(sessionDir, event, ended); }
      catch { this.current.phase = "interrupted"; this.current.error = "录音组件启动失败"; await this.persist(); this.emit(); }
      return this.snapshot();
    });
  }
  private spawnRecorder(dir: string, event: (message: Record<string, unknown>) => void, ended: (code: number | null) => void): Recorder {
    const child = spawn(this.deps.recorderPath, [dir, String(this.settings.chunkSecs)], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { buffer = (buffer + chunk).slice(-16384); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { try { event(JSON.parse(line)); } catch { /* malformed diagnostics */ } } });
    child.stdin.on("error", () => undefined);
    child.on("error", () => ended(1)); child.on("exit", ended);
    return { write: command => child.stdin.write(command + "\n"), kill: () => { child.stdin.end(); child.kill("SIGTERM"); } };
  }
  private async onRecorder(id: string, value: Record<string, unknown>): Promise<void> {
    const record = this.current;
    if (this.disposed || record?.id !== id) return;
    if (value.event === "level") { this.level = typeof value.db === "number" && Number.isFinite(value.db) ? Math.max(-120, Math.min(0, value.db)) : null; this.emit(); return; }
    if (value.event === "ready") { this.recorderReady = true; if (this.startTimeout) clearTimeout(this.startTimeout); this.startTimeout = null; if (record.phase === "starting") record.phase = "recording"; }
    else if (value.event === "paused" && record.phase !== "stopping") record.phase = "paused";
    else if (value.event === "resumed" && record.phase !== "stopping") record.phase = "recording";
    else if (value.event === "error") { record.error = "麦克风录音或音频保存失败，请结束会议并检查权限、设备和磁盘空间"; record.phase = "stopping"; this.recorder?.write("stop"); }
    else if (value.event === "chunk") {
      if (typeof value.name !== "string" || !/^\d{6}\.wav$/.test(value.name) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0
        || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || Number(value.endMs) <= Number(value.startMs)) return;
      if (record.segments.length >= 700) { this.recorder?.write("stop"); record.phase = "stopping"; record.error = "本次会议已达到初版分段上限，请处理完成后开启下一场"; return; }
      const seq = Number(value.seq); if (record.segments.some(segment => segment.seq === seq)) return;
      const silent = Number(value.endMs) - Number(value.startMs) < 500 || typeof value.rms === "number" && value.rms < 0.003 || typeof value.voicedMs === "number" && value.voicedMs < 100;
      const segment: Segment = { id: "s" + seq, seq, startMs: Number(value.startMs), endMs: Number(value.endMs), status: silent ? "empty" : "pending", text: "", error: null, tag: null };
      record.segments.push(segment); record.segments.sort((a, b) => a.seq - b.seq);
      const file = path.join(record.sessionDir, value.name);
      if (silent) await rm(file, { force: true }); else record.audioFiles[segment.id] = file;
      if (this.models.state.status === "ready" && record.segments.filter(s => s.status === "pending").length > 40) { this.recorder?.write("pause"); record.error = "转写积压较多，已请求暂停录音；请等待处理后继续"; }
      await this.persist();
      void this.drain().catch(() => { record.error="转写队列保存失败，请检查磁盘空间";this.emit(); });
    } else if (value.event === "stopped") { this.level = null; }
    this.emit(); await this.persist();
  }
  control(action: string): Promise<Snapshot> {
    return this.exclusive(async () => {
      if (!this.current || !this.recorder) throw Error("当前没有正在录音的会议");
      if (action === "stop") { this.current.phase = "stopping"; this.recorder.write("stop"); }
      else if (action === "pause" && this.current.phase === "recording") this.recorder.write("pause");
      else if (action === "resume" && this.current.phase === "paused") this.recorder.write("resume");
      else throw Error("当前状态不能执行此操作");
      this.emit(); await this.persist(); return this.snapshot();
    });
  }
  /**
   * Windows recognition with whisper-cli. Arguments go through a response file so the Chinese hint reaches it as UTF-8, and every
   * path is relative to the plugin data folder (run as the working directory), so a Chinese user name in the path never matters.
   */
  private async transcribeWindows(binary: string, record: Stored, file: string): Promise<string> {
    const model = await this.models.ensure(record.asrModel); const vad = await this.models.vad();
    const base = this.deps.data; const relative = (target: string) => path.isAbsolute(target) && !path.relative(base, target).startsWith("..") ? path.relative(base, target) : target;
    const out = file.replace(/\.wav$/i, ""), argsFile = out + ".args";
    const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
    const args = ["-m", relative(model), "-f", relative(file), "-l", this.settings.language, "-t", String(threads), "-nt", "-np", "-otxt", "-of", relative(out)];
    const prompt = asrPrompt(this.settings, this.assistant.name).replace(/[\r\n]+/g, " ");
    if (prompt) args.push("--prompt", prompt);
    if (vad) args.push("--vad", "-vm", relative(vad), "-vt", String(VAD[this.settings.vad].threshold), "-vspd", String(VAD[this.settings.vad].minMs));
    await writeFile(argsFile, args.join("\n") + "\n", { mode: 0o600 });
    try {
      await this.run(binary, ["@" + relative(argsFile)], base);
      let text = ""; try { text = await readFile(out + ".txt", "utf8"); } catch { /* nothing recognised */ }
      return text.replace(/\uFFFD/g, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("");
    } finally { await rm(argsFile, { force: true }); await rm(out + ".txt", { force: true }); }
  }
  /** The recognition config for this meeting, pointing at the model file; the first call waits for a model still downloading. */
  private async writeConfig(record: Stored): Promise<void> {
    const model = await this.models.ensure(record.asrModel);
    const key = record.id + "|" + model;
    if (this.configFor === key && this.configFile) return;
    this.configFile = path.join(this.deps.temp, record.id + ".toml");
    await writeFile(this.configFile, asrConfig(model, this.settings, await this.models.vad()), { mode: 0o600 });
    this.configFor = key;
  }
  private async drain(): Promise<void> {
    if (this.processing || this.disposed || !this.current) return;
    // While the model is still being prepared, audio waits on disk instead of failing segment by segment.
    if (this.models.state.status !== "ready") {
      if (this.models.state.status === "failed") return;
      try { if (this.windows) await this.models.ensure(this.current.asrModel); else await this.writeConfig(this.current); } catch { this.emit(); return; }
    }
    this.processing = true;
    const record = this.current;
    try {
      let segment: Segment | undefined;
      while (!this.disposed && (segment = record.segments.find(s => s.status === "pending"))) {
        segment.status = "transcribing"; this.emit(); await this.persist(record);
        try {
          const binary = await this.binary(); if (!binary) throw Error("未找到 voxtype");
          const file = record.audioFiles[segment.id]; if (!file) throw Error("未找到待转写音频");
          let raw: string;
          if (this.windows) raw = await this.transcribeWindows(binary, record, file);
          else {
          await this.writeConfig(record);
          let output: string;
          try { output = await this.run(binary, ["--config", this.configFile, "transcribe", file]); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== INVALID_UTF8) throw error;
            const retry = this.configFile.replace(/\.toml$/, ".retry.toml");
            await writeFile(retry, asrConfig(await this.models.ensure(record.asrModel), this.settings, await this.models.vad(), this.settings.language === "zh" || this.settings.language === "auto" ? RETRY_PROMPT : null), { mode: 0o600 });
            output = await this.run(binary, ["--config", retry, "transcribe", file]);
          }
          raw = parseTranscript(output);
          }
          const polished = raw ? await polishTranscript(raw, this.settings, this.deps.convert ?? (this.windows ? convertOpenCC : convertWith(this.deps.recorderPath))) : "";
          const text = isNoiseTranscript(polished) ? "" : polished;
          if (this.disposed) break;
          if (text.length > 35000) throw Error("转写过长，保留原音频供重试");
          segment.text = text; segment.status = text ? "done" : "empty"; segment.error = null;
          await this.persist(record); // Preserve text before deleting source audio.
          await rm(file, { force: true }); delete record.audioFiles[segment.id];
          this.deps.log("segment_completed", { count: text.length, success: true });
          // Organise at most every 40 s: a little more speech per round gives the model clearer topics (DingTalk refreshes its viewpoint tree about once a minute).
          if (text && this.settings.autoSummary && Date.now() - (record.summaryAt ?? 0) >= 40000) void this.doSummary(false).catch(() => undefined);
          // A request to AI 助手 may be split across two segments, so the previous one is checked together with this one.
          const seq = segment.seq; const before = record.segments.filter(s => s.status === "done" && s.seq < seq).at(-1);
          if (text && this.settings.aiTasks && mentionsAssistant((before?.text ?? "") + text, this.assistant)) void this.findTasks(record).catch(() => undefined);
        } catch { segment.status = "failed"; segment.error = "此段转写失败，音频已保留，可重试"; this.deps.log("segment_failed", { success: false }); }
        await this.persist(record); this.emit();
      }
    } finally { this.processing = false; await this.maybeFinish(); this.emit(); }
  }
  private async maybeFinish(): Promise<void> {
    if (!this.current || this.disposed) return;
    if (this.current.phase === "stopping" && !this.recorder && !this.current.segments.some(s => ["pending", "transcribing"].includes(s.status))) {
      this.current.phase = "complete"; this.current.endedAt = Date.now(); await this.persist();
      if (this.settings.autoSummary) { void this.doSummary(false).catch(() => undefined); try { this.requestMinutes(this.current.id); } catch { /* nothing transcribed */ } }
    }
  }
  private minutesRunning = new Set<string>();
  /** Writes the whole-meeting minutes in the background (a long meeting takes a minute or two); the page follows the state. */
  requestMinutes(id: string): Snapshot {
    const record = this.records.get(id);
    if (!record) throw Error("未找到会议");
    const done = record.segments.filter(segment => segment.status === "done" && segment.text.trim());
    if (!done.length) throw Error("还没有可整理的转写内容");
    if (meaningfulLength(done) < MINUTES_MIN_CHARS) throw Error("转写内容太少（有效内容不到 " + MINUTES_MIN_CHARS + " 字），暂不生成纪要");
    if (this.minutesRunning.has(id)) return this.snapshot(record);
    this.minutesRunning.add(id);
    const through = done[done.length - 1].seq;
    record.minutes = { markdown: record.minutes?.markdown ?? null, at: record.minutes?.at ?? null, through: record.minutes?.through ?? -1, model: record.minutes?.model ?? null, state: "working", error: null };
    void this.persist(record).catch(() => undefined); this.emit();
    void (async () => {
      try {
        const result = await generateMinutes(this.publicMeeting(record), this.deps.generate, this.settings.model);
        if (this.disposed) return;
        record.minutes = { markdown: result.markdown, at: Date.now(), through, model: result.model, state: "idle", error: null };
        this.deps.log("minutes_completed", { count: result.parts, success: true });
      } catch (error) {
        if (this.disposed) return;
        record.minutes = { ...record.minutes!, state: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "纪要生成失败，请重试" };
        this.deps.log("minutes_failed", { success: false });
      } finally {
        this.minutesRunning.delete(id);
        if (!this.disposed) { await this.persist(record).catch(() => undefined); this.emit(); }
      }
    })();
    return this.snapshot(record);
  }
  /** Minutes written elsewhere (for example by the agent the person is talking to) are kept like generated ones and exported as HTML. */
  async saveMinutes(id: string, markdown: string, model: string | null = null): Promise<{ path: string }> {
    const record = this.records.get(id);
    if (!record) throw Error("未找到会议");
    const text = markdown.trim();
    if (!text) throw Error("纪要内容为空");
    const done = record.segments.filter(segment => segment.status === "done" && segment.text.trim());
    record.minutes = { markdown: text.slice(0, 200000), at: Date.now(), through: done.at(-1)?.seq ?? -1, model, state: "idle", error: null };
    await this.persist(record); this.emit();
    return this.exportHtml(id);
  }
  /** Standalone responsive HTML file of the minutes, rendered from escaped Markdown. */
  async exportHtml(id: string): Promise<{ path: string }> {
    const record = this.records.get(id);
    if (!record?.minutes?.markdown) throw Error("这场会议还没有会议纪要，请先生成");
    const directory = path.join(this.deps.data, "exports"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, record.id + "-纪要.html"); await writeFile(file, minutesDocument(record.minutes.markdown, record.title, minutesMeta(record.startedAt, record.endedAt)), { mode: 0o600 });
    return { path: file };
  }
  private taskRunner: Promise<void> | null = null;
  /** Looks at the newest speech for requests to AI 助手 and queues them; one detection at a time per meeting. */
  private detecting = new Set<string>();
  private async findTasks(record: Stored): Promise<void> {
    if (this.detecting.has(record.id)) return;
    this.detecting.add(record.id);
    try {
      const found = await detectTasks(this.publicMeeting(record), this.deps.generate, this.settings.model, this.assistant)
        .catch(error => this.deps.quickTasks ? quickTasks(this.publicMeeting(record), this.assistant) : Promise.reject(error));
      if (!found.length || this.disposed) return;
      record.aiTasks ??= [];
      for (const task of found) record.aiTasks.push({ id: "t" + (record.aiTasks.length + 1), ...task, status: "queued", createdAt: Date.now(), startedAt: null, finishedAt: null, result: null, error: null, turnId: null });
      await this.persist(record); this.emit();
      this.deps.log("task_detected", { count: found.length, success: true });
      this.runTasks();
    } catch { this.deps.log("task_detect_failed", { success: false }); }
    finally { this.detecting.delete(record.id); }
  }
  /** Carries out queued tasks one after another in each meeting's background conversation, across meetings. */
  private runTasks(): void {
    if (this.taskRunner || this.disposed) return;
    this.taskRunner = (async () => {
      for (;;) {
        const record = [...this.records.values()].find(entry => entry.aiTasks?.some(task => task.status === "queued"));
        const task = record?.aiTasks?.find(entry => entry.status === "queued");
        if (!record || !task || this.disposed) return;
        await this.runTask(record, task);
      }
    })().finally(() => { this.taskRunner = null; });
  }
  private async runTask(record: Stored, task: AiTask): Promise<void> {
    const sessions = this.deps.sessions;
    const fail = async (error: string) => { Object.assign(task, { status: "failed", error, finishedAt: Date.now() }); await this.persist(record); this.emit(); this.deps.log("task_failed", { success: false }); };
    if (!sessions) return fail("当前环境不支持在后台执行会中任务");
    Object.assign(task, { status: "running", startedAt: Date.now(), error: null }); await this.persist(record); this.emit();
    try {
      const workspaceId = record.workspaceId ?? await sessions.workspace();
      if (!workspaceId) return fail("没有可用的项目来执行任务，请先在" + this.assistant.name + "里打开一个项目");
      record.workspaceId = workspaceId;
      record.aiSessionId ??= await sessions.start(workspaceId);
      task.turnId = await sessions.send(workspaceId, record.aiSessionId, taskMessage(this.publicMeeting(record), task, sessions.reply ?? "tool"));
      await this.persist(record); this.emit();
      const poll = this.deps.taskPollMs ?? 3000;
      for (const deadline = Date.now() + 15 * 60000; ;) {
        await new Promise(resolve => setTimeout(resolve, poll));
        if (this.disposed) return;
        if (task.status !== "running") return; // the result already arrived through submit_task_result
        let status = "unknown";
        try { status = await sessions.status(workspaceId, record.aiSessionId, task.turnId); } catch { /* try again next round */ }
        if (status === "completed") {
          // Agents run from the command line hand back their final answer as output; the others report through submit_task_result.
          const output = (await sessions.output?.(task.turnId).catch(() => null))?.trim();
          if (task.status === "running") Object.assign(task, output ? { status: "done", finishedAt: Date.now(), result: output.slice(0, 20000), error: null } : { status: "done", finishedAt: Date.now(), result: null, error: "已执行完，但没有把结果交回会议页；可以在" + this.assistant.name + "的会话记录里查看这次执行" });
          break;
        }
        if (status === "failed" || status === "interrupted" || status === "unavailable") return fail(status === "interrupted" ? "执行被中断" : "执行失败，可以在会上重新请" + this.assistant.name + "做一次");
        if (Date.now() > deadline) return fail("超过 15 分钟仍未完成，可能在等待确认；可以在" + this.assistant.name + "的会话记录里查看这次执行");
      }
      await this.persist(record); this.emit();
      this.deps.log("task_completed", { success: true });
    } catch { return fail("没能把任务交给" + this.assistant.name + "，请检查" + this.assistant.name + "是否可用"); }
  }
  /** Called by the background conversation (submit_task_result) with the outcome of one task. */
  async submitTaskResult(meetingId: string, taskId: string, markdown: string): Promise<{ ok: boolean }> {
    const record = this.records.get(meetingId); const task = record?.aiTasks?.find(entry => entry.id === taskId);
    if (!record || !task) throw Error("未找到这个会中任务，请核对 meetingId 和 taskId");
    Object.assign(task, { status: "done", result: markdown.trim().slice(0, 20000) || "（没有返回内容）", error: null, finishedAt: Date.now() });
    await this.persist(record); this.emit();
    return { ok: true };
  }
  summarizeNow(): Snapshot { void this.doSummary(true).catch(() => undefined); return this.snapshot(); }
  /** The person picks the board form; the model keeps it and redraws the whole meeting in that form. */
  /**
   * The person picks a board form. Topic sections and mind maps share the same entries, so that switch is instant.
   * Other forms need the organiser to redraw the meeting; until it succeeds the current board stays on screen.
   */
  async setLayout(id: string, form: string, refresh = false): Promise<Snapshot> {
    if (!BOARD_FORMS.includes(form as BoardForm)) throw Error("不支持的白板形式");
    const record = this.records.get(id);
    if (!record) throw Error("未找到此会议，请从当前会话重新打开");
    if (this.current?.id !== id) throw Error("只能调整当前会议的白板形式");
    const target = form as BoardForm; const now = Date.now(); const previous = record.plan;
    const choose = (): void => { record.plan = { theme: previous?.theme ?? "", center: previous?.center ?? "", type: previous?.type ?? "other", form: target, reason: "按你的要求", decidedAt: now, lockedBy: "user", pendingForm: null, pendingCount: 0 }; record.requestedForm = null; };
    const shared = (a: BoardForm, b: BoardForm) => [a, b].every(item => item === "topics" || item === "mindmap");
    if (refresh && previous && record.items.length) { record.plan = { ...previous, lockedBy: previous.form === target ? previous.lockedBy : "user", pendingForm: null, pendingCount: 0 }; record.requestedForm = target; } // redraw the whole meeting, keeping the current board until it is ready
    else if (!previous || !record.items.length || previous.form === target || shared(previous.form, target)) choose();
    else { record.plan = { ...previous, lockedBy: "user", reason: "按你的要求", pendingForm: null, pendingCount: 0 }; record.requestedForm = target; }
    record.summaryError = null;
    await this.persist(record); this.emit();
    if (record.requestedForm) void this.doSummary(true, true).catch(() => undefined);
    return this.snapshot();
  }
  private async doSummary(manual: boolean, relayout = false): Promise<void> {
    const record = this.current;
    if (!record || this.disposed || (!manual && !this.settings.autoSummary)) return;
    if (this.summarizing) { if (relayout) this.relayoutPending = true; return; }
    if (relayout && !record.requestedForm) return;
    if (!relayout && !record.segments.some(s => s.status === "done" && s.seq > record.summaryThrough)) return;
    const done = record.segments.filter(s => s.status === "done");
    const mustDecide = !record.plan && (done.at(-1)?.endMs ?? 0) >= MUST_DECIDE_AFTER_MS;
    // Listen first: no model call and nothing on the board until there is enough real speech to judge the meeting.
    if (!record.plan && !manual && !mustDecide && meaningfulLength(done) < LISTEN_FIRST_CHARS) return;
    this.summarizing = true; const token = ++this.summaryToken;
    const target = relayout ? record.requestedForm : null;
    record.summaryState = "working"; record.summaryError = null; this.emit();
    try {
      if (target) {
        // Redraw by replaying the meeting in small windows on a copy: each model call stays short, and the board on screen is only replaced once the whole meeting is redrawn.
        const scratch = await this.replay(record, target, token);
        if (!scratch || this.disposed || this.current?.id !== record.id || token !== this.summaryToken) return;
        const now = Date.now();
        record.summaryAt = now; record.summaryState = "idle";
        if (scratch.items.length) {
          Object.assign(record, { items: scratch.items, links: scratch.links, summaries: scratch.summaries, chapters: scratch.chapters ?? null, summaryThrough: scratch.summaryThrough, plan: { ...record.plan!, form: target, decidedAt: now } });
          record.lastChange = scratch.lastChange ? { ...scratch.lastChange, rebuilt: true } : null;
          const tags = new Map(scratch.segments.map(segment => [segment.id, segment.tag]));
          for (const segment of record.segments) if (tags.has(segment.id)) segment.tag = tags.get(segment.id) ?? null;
        } else record.summaryError = "没能按「" + FORM_LABEL[target] + "」重新整理这场会议，已保留原来的白板。可以再试一次或换一种形式";
        record.requestedForm = null; record.notes = notesFromItems(record);
        this.deps.log("summary_completed", { count: record.items.length, success: true });
        return;
      }
      const result = await summarize(structuredClone(record), this.deps.generate, this.settings.model, { relayout, mustDecide, target: target ?? undefined, form: this.settings.defaultForm === "auto" ? undefined : this.settings.defaultForm });
      if (this.disposed || this.current?.id !== record.id || token !== this.summaryToken) return;
      const now = Date.now();
      record.summaryAt = now; record.summaryState = "idle";
      if (result) {
        record.summaryThrough = result.through;
        const before = record.plan;
        let plan = mergePlan(before, result.plan, now, mustDecide);
        const preferred = this.settings.defaultForm;
        if (!before && plan && preferred !== "auto") plan = { ...plan, form: preferred, lockedBy: "user", reason: "按设置的默认形式" };
        const chatter = Array.isArray(result.body.chatter) ? new Set(result.body.chatter) : new Set();
        for (const segment of record.segments) if (chatter.has(segment.id)) segment.tag = "chatter";
        if (target && plan) {
          // Redraw in the requested form; an empty answer never replaces what is on the board.
          const round = applyRound(record, result.body, target, "rebuild", now);
          if (round.items.length) { record.items = round.items; record.links = round.links; record.summaries = round.summaries; record.lastChange = round.change; record.chapters = round.chapters; record.plan = { ...plan, form: target, decidedAt: now }; }
          else { record.plan = plan; record.summaryError = "没能按「" + FORM_LABEL[target] + "」重新整理这场会议，已保留原来的白板。可以再试一次或换一种形式"; }
          record.requestedForm = null;
        } else if (plan && before && plan.form !== before.form && record.items.length) {
          // The organiser judged the meeting changed nature: keep the current board and redraw once in the new form.
          record.plan = { ...plan, form: before.form }; record.requestedForm = plan.form; this.relayoutPending = true;
        } else {
          record.plan = plan;
          if (plan) { const round = applyRound(record, result.body, plan.form, result.mode, now); record.items = round.items; record.links = round.links; record.summaries = round.summaries; record.lastChange = round.change; record.chapters = round.chapters; }
        }
        record.notes = notesFromItems(record);
      }
      this.deps.log("summary_completed", { count: record.items.length, success: true });
    } catch {
      if (!this.disposed && this.current?.id === record.id) {
        record.summaryState = "failed";
        record.summaryError = target ? "没能按「" + FORM_LABEL[target] + "」重新整理，已保留原来的白板，可以再试一次" : "AI 整理失败，已保留上次结果，可点“立即整理”重试";
        if (target) record.requestedForm = null;
        this.deps.log("summary_failed", { success: false });
      }
    }
    finally {
      this.summarizing = false; record.redraw = null; if (!this.disposed && token === this.summaryToken) { await this.persist(record); this.emit(); }
      if (this.relayoutPending && !this.disposed) { this.relayoutPending = false; void this.doSummary(true, true).catch(() => undefined); }
    }
  }
  /**
   * Replays the meeting on a copy with an empty board, REDRAW_WINDOW segments at a time, as if it were happening live in the target form.
   * A window that fails twice leaves its speech uncovered, so the next window reads it again; the redraw fails only when the end of the meeting stays uncovered.
   */
  private async replay(record: Stored, target: BoardForm, token: number): Promise<Meeting | null> {
    const all = record.segments.filter(segment => segment.status === "done").map(segment => ({ ...segment, tag: null }));
    if (!all.length || !record.plan) return { ...this.publicMeeting(record), items: [] };
    const scratch: Meeting = { ...structuredClone(this.publicMeeting(record)), segments: [], items: [], links: [], summaries: [], chapters: null, lastChange: null, summaryThrough: -1, requestedForm: null, aiTasks: [], minutes: null, redraw: null, plan: { ...record.plan, form: target, lockedBy: "user", pendingForm: null, pendingCount: 0 } };
    const total = Math.ceil(all.length / REDRAW_WINDOW); let failedInRow = 0;
    const round = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.disposed || token !== this.summaryToken || this.current?.id !== record.id) return false;
        try {
          const result = await summarize(structuredClone(scratch), this.deps.generate, this.settings.model, { target });
          if (!result) return true;
          scratch.summaryThrough = result.through;
          const chatter = Array.isArray(result.body.chatter) ? new Set(result.body.chatter) : new Set();
          for (const segment of scratch.segments) if (chatter.has(segment.id)) segment.tag = "chatter";
          const applied = applyRound(scratch, result.body, target, "append", scratch.segments.at(-1)?.endMs ?? Date.now());
          Object.assign(scratch, { items: applied.items, links: applied.links, summaries: applied.summaries, chapters: applied.chapters, lastChange: applied.change });
          return true;
        } catch { /* one retry; the host caps each model call */ }
      }
      return false;
    };
    for (let index = 0; index < total; index++) {
      record.redraw = { done: index, total }; this.emit();
      scratch.segments = all.slice(0, (index + 1) * REDRAW_WINDOW);
      if (await round()) failedInRow = 0;
      else if (++failedInRow >= 3) throw Error("redraw failed");
      if (this.disposed || token !== this.summaryToken || this.current?.id !== record.id) return null;
    }
    if (scratch.summaryThrough < all.at(-1)!.seq && !(await round())) throw Error("redraw incomplete");
    record.redraw = { done: total, total };
    return scratch;
  }
  open(id: string): Promise<Snapshot> { return this.exclusive(async () => { if (this.isActive() || this.processing) throw Error("请结束当前录音并等待处理完成后再切换会议"); const record = this.records.get(id); if (!record) throw Error("未找到会议"); this.current = record; this.level = null; this.emit(); return this.snapshot(); }); }
  retry(): Promise<Snapshot> { return this.exclusive(async () => {
    if (!this.current) throw Error("请先选择会议");
    if (this.isActive() || this.processing || this.summarizing) throw Error("请等待会议结束后重试");
    this.current.asrModel ||= "large-v3-turbo"; this.configFor = "";
    if (this.models.state.status === "failed") this.prepare();
    // Retrying earlier gaps invalidates coverage so they cannot disappear behind the cursor.
    const failed = this.current.segments.filter(s => s.status === "failed" && this.current!.audioFiles[s.id]);
    if (failed.length) this.current.summaryThrough = Math.min(this.current.summaryThrough, Math.min(...failed.map(s => s.seq)) - 1);
    for (const segment of failed) { segment.status = "pending"; segment.error = null; }
    await this.persist(); void this.drain().catch(() => { if(this.current){this.current.error="重试保存失败，请检查磁盘空间";this.emit();} }); this.emit(); return this.snapshot();
  }); }
  async export(id?: string): Promise<{ path: string; text: string }> {
    const record = id ? this.records.get(id) : this.current;
    if (!record) throw Error("请先选择会议");
    const text = (record.minutes?.markdown ? record.minutes.markdown + "\n\n---\n\n" : "") + markdown(record);
    const directory = path.join(this.deps.data, "exports"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, record.id + ".md"); await writeFile(file, text, { mode: 0o600 });
    return { path: file, text };
  }
  dispose(): void { if (this.startTimeout) clearTimeout(this.startTimeout); for (const child of this.transcriptionChildren) child.kill("SIGTERM"); this.disposed = true; this.summaryToken++; if (this.tick) clearInterval(this.tick); this.recorder?.kill(); this.recorder = null; }
}
