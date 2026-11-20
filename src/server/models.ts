import { createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Whisper models the meeting plugin can fetch by itself. Sizes are the published file sizes and double as an integrity check. */
export const ASR_MODELS: Record<string, { file: string; size: number; label: string }> = {
  "large-v3-turbo-q5_0": { file: "ggml-large-v3-turbo-q5_0.bin", size: 574041195, label: "推荐 · 574MB" },
  "large-v3-turbo": { file: "ggml-large-v3-turbo.bin", size: 1624555275, label: "更准 · 1.6GB" },
  "small": { file: "ggml-small.bin", size: 487601967, label: "较快 · 488MB" },
};
export const DEFAULT_ASR_MODEL = "large-v3-turbo-q5_0";
/** Windows recognises on the CPU, where large models fall behind a live meeting; small keeps up on ordinary laptops. */
export const WINDOWS_DEFAULTS = { model: "small", prefer: ["small"] };
export type ModelDefaults = { model: string; prefer: string[] };
const VAD = { file: "ggml-silero-vad.bin", remote: "ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin", size: 885098 };
/** Tried in order; the mirror serves the same files for networks where huggingface.co is slow or blocked. */
export const MODEL_SOURCES = ["https://huggingface.co", "https://hf-mirror.com"];

export type SetupState = { status: "checking" | "downloading" | "ready" | "failed"; model: string; received: number; total: number; error: string | null };
type Fetch = typeof fetch;

/**
 * Finds and fetches recognition models. Models live in the plugin's own data folder; a model voxtype already
 * downloaded (~/.local/share/voxtype/models) is reused as is, so people who have one never download it again.
 */
export class ModelStore {
  state: SetupState;
  private running: Promise<string> | null = null;
  private readyFile: string | null = null;
  private readonly dirs: string[];
  constructor(private readonly dir: string, private readonly onChange: (state: SetupState) => void, private readonly fetchImpl: Fetch = fetch, shared: string | null = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "voxtype/models"), private readonly defaults: ModelDefaults = { model: DEFAULT_ASR_MODEL, prefer: ["large-v3-turbo", DEFAULT_ASR_MODEL] }) {
    this.dirs = shared ? [dir, shared] : [dir];
    this.state = { status: "checking", model: defaults.model, received: 0, total: 0, error: null };
  }
  private async find(file: string, size?: number): Promise<string | null> {
    for (const dir of this.dirs) {
      try { const info = await stat(path.join(dir, file)); if (info.isFile() && (size ? info.size === size : info.size > 1000000)) return path.join(dir, file); } catch { /* not here */ }
    }
    return null;
  }
  /** Absolute path of an installed model, or null. */
  locate(name: string): Promise<string | null> { const known = ASR_MODELS[name]; return this.find(known?.file ?? "ggml-" + name + ".bin", known?.size); }
  vad(): Promise<string | null> { return this.find(VAD.file, VAD.size); }
  async installed(): Promise<string[]> {
    const names: string[] = [];
    for (const name of Object.keys(ASR_MODELS)) if (await this.locate(name)) names.push(name);
    return names;
  }
  /** The model to use when the person has not picked one: an installed turbo model first, otherwise the default to download. */
  async preferred(chosen: string | null): Promise<string> {
    if (chosen && (await this.locate(chosen) || ASR_MODELS[chosen])) return chosen;
    for (const name of this.defaults.prefer) if (await this.locate(name)) return name;
    return this.defaults.model;
  }
  private set(next: Partial<SetupState>): void { this.state = { ...this.state, ...next }; this.onChange(this.state); }
  /** Makes sure the model and the speech detector are on disk; one download at a time, later callers share it. */
  ensure(name: string): Promise<string> {
    if (this.state.status === "ready" && this.state.model === name && this.readyFile) return Promise.resolve(this.readyFile);
    if (this.running && this.state.model === name) return this.running;
    const run = (async () => {
      this.set({ status: "checking", model: name, error: null, received: 0, total: 0 });
      const known = ASR_MODELS[name];
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (!await this.vad()) await this.download(VAD.remote, VAD.file, VAD.size, false);
        const found = await this.locate(name);
        if (found) { this.readyFile = found; this.set({ status: "ready" }); return found; }
        if (!known) throw Error("识别模型 " + name + " 未安装，请在设置里换成可自动下载的模型");
        const file = await this.download("ggerganov/whisper.cpp/resolve/main/" + known.file, known.file, known.size, true);
        this.readyFile = file; this.set({ status: "ready", received: known.size, total: known.size });
        return file;
      } catch (error) {
        this.set({ status: "failed", error: error instanceof Error ? error.message : "识别模型下载失败" });
        throw error;
      }
    })();
    this.running = run;
    void run.finally(() => { if (this.running === run) this.running = null; }).catch(() => undefined);
    return run;
  }
  /** Resumable download into name.part; checks size and the ggml header before the file takes its final name. */
  private async download(remote: string, file: string, size: number, report: boolean): Promise<string> {
    const target = path.join(this.dir, file), part = target + ".part";
    let lastError = "网络不可用";
    for (const source of MODEL_SOURCES) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let have = 0;
        try { have = (await stat(part)).size; } catch { /* fresh */ }
        if (have > size) { await unlink(part).catch(() => undefined); have = 0; }
        const controller = new AbortController();
        let idle: ReturnType<typeof setTimeout> | undefined;
        const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => controller.abort(), 30000); };
        try {
          touch();
          if (have < size) {
            const response = await this.fetchImpl(source + "/" + remote, { headers: have ? { range: "bytes=" + have + "-" } : {}, redirect: "follow", signal: controller.signal });
            if (!response.ok || !response.body) throw Error("下载源返回 " + response.status);
            if (have && response.status !== 206) have = 0; // the source ignored the range: start over
            const out = createWriteStream(part, { flags: have ? "a" : "w", mode: 0o600 });
            let received = have, reportedAt = 0;
            if (report) this.set({ status: "downloading", received, total: size });
            try {
              for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                touch();
                received += chunk.length;
                if (!out.write(chunk)) await new Promise<void>(resolve => out.once("drain", () => resolve()));
                if (report && Date.now() - reportedAt > 500) { reportedAt = Date.now(); this.set({ received }); }
                if (received > size) throw Error("文件大小不符");
              }
            } finally { await new Promise<void>(resolve => out.end(resolve)); }
          }
          const info = await stat(part);
          if (info.size !== size) throw Error("下载未完成");
          const handle = await open(part, "r"); const head = Buffer.alloc(4);
          try { await handle.read(head, 0, 4, 0); } finally { await handle.close(); }
          if (head.toString("latin1") !== "lmgg") { await unlink(part).catch(() => undefined); throw Error("文件校验失败"); }
          await rename(part, target);
          return target;
        } catch (error) {
          lastError = controller.signal.aborted ? "下载超时" : error instanceof Error ? error.message : "下载失败";
        } finally { if (idle) clearTimeout(idle); }
      }
    }
    throw Error("识别模型下载失败（" + lastError + "），请检查网络后重试");
  }
}

