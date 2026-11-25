/**
 * Live captions from the recogniser the meeting already uses (whisper on this computer, or the configured transcription
 * endpoint). While people speak, the audio of the chunk being recorded is recognised again every couple of seconds and
 * shown as grey draft text. When the chunk is handed to recognition its draft stays on screen and drafting moves on to the
 * next chunk; when the chunk's caption is saved, the caption takes over. Saved captions are still recognised from the
 * chunk files, so a missing or wrong draft never changes the record.
 */
import { rm, writeFile } from "node:fs/promises";
import type { LiveCaption, VoiceUtterance } from "../shared";

/** The recorder streams 16 kHz mono 16-bit PCM. */
const BYTES_PER_MS = 32;
/** A draft covers at most this much audio; when saved captions fall further behind, it shows only the latest speech. */
export const MAX_DRAFT_MS = 30000;
/** New audio needed before the draft is recognised again. */
const MIN_NEW_MS = 800;
/** Audio quieter than this (RMS of 16-bit samples, about the recorder's quiet-chunk level) is not sent to the recogniser. */
const QUIET_RMS = 100;

export type LivePreviewOptions = {
  /** Recognises a 16 kHz mono WAV file and returns cleaned text, "" when nothing was said. */
  recognise: (file: string) => Promise<string>;
  /** Where each draft's audio is written; it is removed after every pass. */
  file: string;
  /** Pause between passes, counted from the end of the previous pass so a slow recogniser is never asked twice at once. */
  everyMs: number;
  /** True while saved chunks wait for recognition: they go first. */
  busy: () => boolean;
  onLive: () => void;
};

export class LivePreview {
  /** Drafts never become saved captions: every chunk is still recognised from its own file. */
  readonly active = false;
  private pcm: Buffer[] = [];
  private bytes = 0;
  /** Meeting time (ms of audio) of the first buffered byte, and of all audio received. */
  private from = 0;
  private heard = 0;
  private draft: VoiceUtterance | null = null;
  /** Drafts of chunks handed to recognition, shown until their captions are saved. */
  private sealed: VoiceUtterance[] = [];
  private recognisedThrough = -1;
  /** Changes when a chunk leaves the draft, so a pass started before that is dropped. */
  private generation = 0;
  private running = false;
  private paused = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LivePreviewOptions) { this.schedule(options.everyMs); }

  push(pcm: Buffer): void {
    if (this.stopped || !pcm.length) return;
    this.pcm.push(pcm); this.bytes += pcm.length; this.heard += pcm.length / BYTES_PER_MS;
    if (this.heard - this.from > MAX_DRAFT_MS) this.dropBefore(this.heard - MAX_DRAFT_MS);
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  finish(): Promise<void> { this.stop(); return Promise.resolve(); }
  abort(): void { this.stop(); this.draft = null; this.sealed = []; }
  /** The chunk up to endMs is being recognised from its file: its draft stays as it is and drafting continues after it. */
  transcribeChunk(_startMs: number, endMs: number): Promise<VoiceUtterance[] | null> {
    if (this.draft && this.draft.startMs < endMs) { this.sealed.push(this.draft); this.draft = null; }
    this.moveOn(endMs);
    return Promise.resolve(null);
  }
  live(): LiveCaption {
    // There is no speaker recognition here: names are never shown and nothing waits for them.
    const sentences = this.draft ? [...this.sealed, this.draft] : this.sealed;
    return { sentences: sentences.map(sentence => ({ ...sentence, definite: false })), speakerThrough: Number.MAX_SAFE_INTEGER, heardMs: this.heard, speakers: false };
  }
  /** The chunk up to endMs is saved: its caption replaces its draft. */
  release(endMs: number): void {
    this.sealed = this.sealed.filter(sentence => sentence.startMs >= endMs);
    if (this.draft && this.draft.startMs < endMs) this.draft = null;
    if (this.from < endMs) this.moveOn(endMs);
  }

  /** Audio before ms leaves the draft; what follows is recognised again right away. */
  private moveOn(ms: number): void {
    this.generation++;
    this.dropBefore(ms);
    this.recognisedThrough = -1;
    if (!this.running && !this.stopped) this.schedule(0);
  }
  private stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.pass(); }, ms);
    this.timer.unref();
  }
  private dropBefore(ms: number): void {
    let drop = Math.min(this.bytes, Math.max(0, Math.round((ms - this.from) * BYTES_PER_MS / 2) * 2));
    this.from += drop / BYTES_PER_MS; this.bytes -= drop;
    while (drop > 0) {
      const first = this.pcm[0];
      if (first.length <= drop) { this.pcm.shift(); drop -= first.length; }
      else { this.pcm[0] = first.subarray(drop); drop = 0; }
    }
  }
  private async pass(): Promise<void> {
    if (this.stopped) return;
    const enoughNew = this.heard - this.recognisedThrough >= MIN_NEW_MS && this.bytes >= MIN_NEW_MS * BYTES_PER_MS;
    if (this.paused || !enoughNew || this.options.busy()) { this.schedule(this.options.everyMs); return; }
    const audio = Buffer.concat(this.pcm, this.bytes);
    const startMs = this.from, endMs = this.heard, generation = this.generation;
    this.recognisedThrough = endMs;
    this.running = true;
    let text: string | null = "";
    try {
      if (loudness(audio) >= QUIET_RMS) {
        await writeFile(this.options.file, wav(audio), { mode: 0o600 });
        text = await this.options.recognise(this.options.file);
      }
    } catch { text = null; /* the previous draft stays; the saved chunk is recognised as usual */ }
    finally { this.running = false; await rm(this.options.file, { force: true }).catch(() => undefined); }
    if (this.stopped) return;
    if (generation === this.generation && text !== null) {
      const before = this.draft?.text ?? "";
      this.draft = text ? { startMs, endMs, text } : null;
      if (before !== text) this.options.onLive();
    }
    this.schedule(generation === this.generation ? this.options.everyMs : 0);
  }
}

/** RMS of 16-bit little-endian samples. */
export function loudness(pcm: Buffer): number {
  const count = pcm.length >> 1;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) { const value = pcm.readInt16LE(i * 2); sum += value * value; }
  return Math.sqrt(sum / count);
}

/** A 16 kHz mono 16-bit WAV file, the format the recorder writes its chunks in. */
export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
