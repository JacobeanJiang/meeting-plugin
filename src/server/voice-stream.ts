import WebSocket from 'ws';
import type { LiveCaption, SpeakerChange, VoiceUtterance } from '../shared';

const MAX_BUFFER = 32000 * 12;
const CLOCK_BYTES_PER_MS = 32;
/** The first draft can come 1.5 s after speech starts; this much audio after a chunk with no draft in it means the chunk ended in silence. */
const QUIET_AFTER_MS = 2500;
/**
 * The service keeps a sentence as a draft until the next one starts, so after a pause it can stay unfinished for a long
 * time. A chunk waits this long for its sentences to be final, showing them live meanwhile, before its WAV is recognised.
 */
const CHUNK_WAIT_MS = 45000;

/** Connect only when a person has selected an endpoint. All timestamps use recording time, excluding pauses. */
export function configuredVoiceStream(env: Record<string, string | undefined>) {
  const endpoint = env.MEETING_VOICE_STREAM_URL?.trim();
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))) {
    throw Error('MEETING_VOICE_STREAM_URL 必须是 wss 地址，本机可使用 ws。请单独配置 API Key');
  }
  const token = env.MEETING_VOICE_STREAM_API_KEY?.trim() || '';
  return (speaker: (change: SpeakerChange) => void, changed?: () => void) => new VoiceStream(url, token, speaker, changed);
}

// One clock and one socket per recording. Local WAV chunks stay available until their text is committed.
export class VoiceStream {
  private socket: WebSocket;
  private state: 'connecting' | 'ready' | 'done' | 'failed' = 'connecting';
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private sentBytes = 0;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout>;
  private utterances = new Map<number, VoiceUtterance>();
  /** The sentences still being spoken, as last recognised; shown live, never saved. */
  private drafts: VoiceUtterance[] = [];
  /** Sentences handed to a chunk stay on screen until that chunk's caption is saved. */
  private handed: (VoiceUtterance & { definite: boolean })[] = [];
  /** A final sentence that started in an already saved chunk: the following chunk up to here lacks its words. */
  private lostUntil = 0;
  private watermark = 0;
  private lastSpeakerAt = -1;
  private pausedAt: number | null = null;
  private committedThrough = 0;
  private listeners = new Set<() => void>();
  get active(): boolean { return this.state !== 'failed'; }

  constructor(url: URL, token: string, private onSpeaker: (change: SpeakerChange) => void, private onLive: () => void = () => {}) {
    this.socket = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, handshakeTimeout: 8000, maxPayload: 1024 * 1024 });
    this.timer = setTimeout(() => this.abort(), 12000);
    this.timer.unref();
    this.socket.on('error', () => this.abort());
    this.socket.on('close', () => this.abort());
    this.socket.on('message', (data, binary) => {
      if (binary || this.state === 'failed' || this.state === 'done') return;
      try { this.receive(JSON.parse(data.toString())); } catch { this.abort(); }
    });
  }

  private receive(event: Record<string, unknown>) {
    if (!event || typeof event !== 'object') { this.abort(); return; }
    if (event.type === 'ready' && this.state === 'connecting') {
      this.state = 'ready';
      clearTimeout(this.timer);
      for (const pcm of this.buffered) this.send(pcm);
      this.buffered = [];
      this.bufferedBytes = 0;
      if (this.stopping && this.state === 'ready') this.sendFinish();
    } else if (event.type === 'transcript' && this.state === 'ready') {
      const rows = Array.isArray(event.utterances) ? event.utterances : [];
      const drafts: VoiceUtterance[] = [];
      for (const row of rows) {
        if (!row || typeof row.text !== 'string' || !row.text.trim()) continue;
        const { startMs, endMs } = row;
        // Drafts change as the speaker goes on; they are shown live and only final sentences become captions.
        if (row.definite !== true) {
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs > startMs) drafts.push({ startMs, endMs, text: row.text.trim().slice(0, 35000) });
          continue;
        }
        // Without a time range we cannot attach the text to recoverable audio. Let the existing recognizer handle it.
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > this.sentBytes / CLOCK_BYTES_PER_MS + 200) {
          this.abort(); return;
        }
        if (startMs < this.committedThrough) { this.lostUntil = Math.max(this.lostUntil, endMs); continue; }
        this.utterances.set(startMs, { startMs, endMs, text: row.text.trim().slice(0, 35000) });
        this.watermark = Math.max(this.watermark, endMs);
      }
      this.drafts = drafts;
      this.notify();
      this.onLive();
    } else if (event.type === 'speaker' && this.state === 'ready') {
      const { endMs, name: label } = event;
      if (typeof endMs !== 'number' || !Number.isFinite(endMs) || endMs <= this.lastSpeakerAt || endMs > this.sentBytes / CLOCK_BYTES_PER_MS) return;
      this.lastSpeakerAt = endMs;
      const name = typeof label === 'string' ? label.trim().slice(0, 100) || null : null;
      this.onSpeaker({ atMs: endMs, name });
      this.onLive();
    } else if (event.type === 'done' && this.stopping && this.state === 'ready') {
      this.state = 'done';
      clearTimeout(this.timer);
      this.notify();
      this.socket.close();
    }
  }

  private notify() { for (const listener of this.listeners) listener(); }

  private send(pcm: Buffer) {
    if (this.state !== 'ready') return;
    if (this.socket.bufferedAmount > MAX_BUFFER) { this.abort(); return; }
    this.socket.send(pcm, error => { if (error) this.abort(); });
    this.sentBytes += pcm.length;
    this.notify();
  }

  push(pcm: Buffer) {
    if (this.state === 'ready') this.send(pcm);
    else if (this.state === 'connecting') {
      this.bufferedBytes += pcm.length;
      if (this.bufferedBytes > MAX_BUFFER) { this.abort(); return; }
      this.buffered.push(pcm);
    }
  }

  pause() {
    // The recorder's clock excludes pauses. A long pause times out at the upstream and uses WAV fallback on resumption.
    this.pausedAt = Date.now();
  }

  resume() {
    if (this.pausedAt !== null && Date.now() - this.pausedAt >= 44000) this.abort();
    this.pausedAt = null;
  }

  finish(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (this.state === 'ready') this.sendFinish();
    }
    if (this.state === 'done' || this.state === 'failed') return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (this.state !== 'done' && this.state !== 'failed') return;
        this.listeners.delete(check);
        resolve();
      };
      this.listeners.add(check);
    });
  }

  private sendFinish() {
    if (!this.sentBytes) { this.abort(); return; }
    this.socket.send('finish', error => { if (error) this.abort(); });
    this.timer = setTimeout(() => this.abort(), 12000);
    this.timer.unref();
  }

  abort() {
    if (this.state === 'done' || this.state === 'failed') return;
    clearTimeout(this.timer);
    this.state = 'failed';
    this.buffered = [];
    this.bufferedBytes = 0;
    this.drafts = [];
    this.notify();
    this.onLive();
    this.socket.terminate();
  }

  /** True once the audio after a chunk has been heard and nothing said before its end is still a draft. */
  private quietAfter(endMs: number): boolean {
    return this.state === 'ready' && this.sentBytes / CLOCK_BYTES_PER_MS >= endMs + QUIET_AFTER_MS && !this.drafts.some(row => row.startMs < endMs);
  }

  /**
   * What has been heard but is not yet in a saved caption, and how far the speaker results reach. After the stream ends its
   * final sentences stay until their chunks are saved, so the text does not vanish and come back; no more speaker results
   * will come then, so nothing waits for them.
   */
  live(): LiveCaption {
    const open = this.state === 'connecting' || this.state === 'ready';
    const finals = [...this.utterances.values()].map(row => ({ ...row, definite: true }));
    const drafts = open ? this.drafts.filter(row => row.startMs >= this.committedThrough).map(row => ({ ...row, definite: false })) : [];
    const sentences = [...this.handed, ...finals, ...drafts].sort((a, b) => a.startMs - b.startMs);
    return { sentences, speakerThrough: open ? this.lastSpeakerAt : Number.MAX_SAFE_INTEGER, heardMs: this.sentBytes / CLOCK_BYTES_PER_MS };
  }

  /** The chunk ending here now has its saved caption, so its sentences leave the live view. */
  release(endMs: number) {
    this.handed = this.handed.filter(row => row.startMs >= endMs);
  }

  async transcribeChunk(startMs: number, endMs: number): Promise<VoiceUtterance[] | null> {
    // A later final sentence establishes coverage; so does silence at the chunk boundary with no draft left before it.
    const settled = () => this.watermark >= endMs || this.state === 'done' || this.state === 'failed' || this.quietAfter(endMs);
    if (!settled()) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timeout); this.listeners.delete(check); resolve(); };
        const check = () => { if (settled()) done(); };
        const timeout = setTimeout(done, CHUNK_WAIT_MS);
        this.listeners.add(check);
      });
    }
    const heard = this.watermark >= endMs || this.quietAfter(endMs) || (this.state === 'done' && this.sentBytes / CLOCK_BYTES_PER_MS >= endMs);
    const covered = heard && this.lostUntil <= startMs;
    const result = [...this.utterances.values()].filter(row => row.startMs >= startMs && row.startMs < endMs).sort((a, b) => a.startMs - b.startMs);
    const drafts = this.drafts.filter(row => row.startMs >= this.committedThrough && row.startMs < endMs);
    this.committedThrough = Math.max(this.committedThrough, endMs);
    for (const [key, row] of this.utterances) if (row.startMs < endMs) this.utterances.delete(key);
    this.handed.push(...result.map(row => ({ ...row, definite: true })), ...drafts.map(row => ({ ...row, definite: false })));
    return covered ? result : null;
  }
}
