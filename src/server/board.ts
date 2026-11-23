import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { startBoardEngine, type BoardEngine } from "../../vendor/open-artifact.mjs";
import type { BoardSpace, Snapshot } from "../shared";
import { layoutBoard } from "./layout";
export type BoardRead = {
  meetingId: string; revision: string; observedAt: number;
  documents: { id: string; sha256: string; data: Record<string, unknown> }[];
  selection: unknown; selectionAt: string | number | null; error: string | null;
};
/** published: ids the plugin created; written: content hash the plugin last saw for its own elements; deleted: ids people removed. */
type Link = { published: string[]; deleted: string[]; written?: Record<string, string>; lastSyncedAt: number | null };
type Doc = { id: string; sha256: string; data: Record<string, unknown> };
export class MeetingBoards {
  private engine: BoardEngine | null = null;
  private engineStarting: Promise<BoardEngine> | null = null;
  private links = new Map<string, Link>();
  private urls = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private openings = new Set<Promise<string>>();
  private closing = false;
  private closeTask: Promise<void> | null = null;
  /** space: how much room the screens showing the board have right now; the layout follows it. */
  constructor(private readonly data: string, private readonly assets: string, private readonly space: () => BoardSpace = () => "normal") {}
  private root(id: string): string { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("无效会议"); return path.join(this.data, "boards", id); }
  private async getEngine(): Promise<BoardEngine> {
    if(this.closing)throw Error("白板服务正在关闭");
    if (this.engine) return this.engine;
    this.engineStarting ??= startBoardEngine(this.assets).then(engine => this.engine = engine).finally(() => { this.engineStarting = null; });
    return this.engineStarting;
  }
  open(id: string, title: string): Promise<string> {
    if(this.closing)return Promise.reject(Error("白板服务正在关闭"));
    const pending=this.doOpen(id,title);this.openings.add(pending);
    void pending.then(()=>this.openings.delete(pending),()=>this.openings.delete(pending));
    return pending;
  }
  private async doOpen(id: string, title: string): Promise<string> {
    const engine = await this.getEngine();
    if(this.closing)throw Error("白板服务正在关闭");
    const url = await engine.open(this.root(id), title);
    this.urls.set(id, url);
    if (!this.links.has(id)) {
      try { this.links.set(id, JSON.parse(await readFile(path.join(this.root(id), "meeting-links.json"), "utf8")) as Link); }
      catch { this.links.set(id, { published: [], deleted: [], lastSyncedAt: null }); }
    }
    return url;
  }
  sync(snapshot: Snapshot): Promise<void> {
    const next = this.queue.then(() => this.doSync(snapshot));
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async doSync(snapshot: Snapshot): Promise<void> {
    const meeting = snapshot.meeting; if (!meeting) return;
    await this.open(meeting.id, meeting.title);
    const engine = await this.getEngine();
    const root = this.root(meeting.id);
    const link = this.links.get(meeting.id)!;
    const written = link.written ??= {};
    const docs = new Map(((engine.read(root, "elements") as { docs?: Doc[] }).docs ?? []).map(doc => [doc.id, doc]));
    // Elements the plugin made that people have since removed stay removed.
    for (const id of link.published) if (!docs.has(id) && !link.deleted.includes(id)) { link.deleted.push(id); delete written[id]; }
    // Boards from 0.1.x: adopt untouched generated elements so they can be replaced by the structured layout.
    for (const id of link.published) {
      const doc = docs.get(id); if (!doc || written[id]) continue;
      const text = String(doc.data.text ?? "");
      if (doc.data.by === "agent" && ((id.startsWith("transcript-") && text.includes("] 原始转写")) || (id === "meeting-title" && text === meeting.title))) written[id] = doc.sha256;
    }
    // Lines, frames and the mind-map centre the plugin drew always follow the layout: the editor rewrites them on its own
    // (default fields, sub-pixel positions), which used to look like a person's edit and froze stale structure on the board.
    const structural = (doc: Doc) => doc.data.by === "agent" && (doc.data.type === "arrow" || doc.data.type === "container" || doc.id === "mm-center");
    const untouched = (doc: Doc) => written[doc.id] === doc.sha256 || structural(doc);
    const desired = layoutBoard(meeting, new Set(link.deleted), this.space());
    // Mind-map lines start at a point on their parent's edge (see branchLine): they go with a removed parent and start from
    // where a person moved it, letting the board route the rest.
    for (const [id, data] of desired) {
      const anchor = data.anchor as { id: string; side: "left" | "right" } | undefined;
      if (!anchor) continue;
      delete data.anchor;
      if (link.deleted.includes(anchor.id)) { desired.delete(id); continue; }
      const parent = docs.get(anchor.id);
      if (!parent || untouched(parent)) continue;
      const { x, y, w, h } = parent.data as { x: number; y: number; w: number; h: number };
      data.from = [Math.round(anchor.side === "right" ? x + w : x), Math.round(y + h / 2)];
    }
    const writes: { op: "set" | "delete"; path: string; if_match: string | null; data?: Record<string, unknown> }[] = [];
    // An arrow needs both ends: when a person removed a node (a topic, a viewpoint, the centre), its lines go too.
    const gone = (end: unknown) => typeof end === "string" && link.deleted.includes(end);
    for (const [id, data] of desired) if (data.type === "arrow" && (gone(data.from) || gone(data.to))) desired.delete(id);
    for (const [id, data] of desired) {
      if (link.deleted.includes(id)) continue;
      const doc = docs.get(id);
      if (!doc) { writes.push({ op: "set", path: "elements/" + id, if_match: null, data }); continue; }
      if (!untouched(doc)) continue; // a person edited or moved it: theirs now
      if (JSON.stringify(doc.data) !== JSON.stringify({ ...doc.data, ...data })) writes.push({ op: "set", path: "elements/" + id, if_match: doc.sha256, data });
    }
    for (const id of link.published) {
      const doc = docs.get(id);
      if (doc && !desired.has(id) && untouched(doc)) writes.push({ op: "delete", path: "elements/" + id, if_match: doc.sha256 });
    }
    // Every arrow on the resulting board needs both ends. An arrow a person adjusted is theirs, but once one of its ends goes
    // (for example when the board changes form) it cannot stay: the board rejects the whole write otherwise and stops syncing.
    const target = (write: (typeof writes)[number]) => write.path.split("/")[1];
    const removing = new Set(writes.filter(write => write.op === "delete").map(target));
    const setting = new Set(writes.filter(write => write.op === "set").map(target));
    const present = new Set([...[...docs.keys()].filter(id => !removing.has(id)), ...setting]);
    const whole = (data: Record<string, unknown>) => [data.from, data.to].every(end => typeof end !== "string" || present.has(end));
    for (const doc of docs.values()) if (doc.data.type === "arrow" && !removing.has(doc.id) && !setting.has(doc.id) && !whole(doc.data)) { writes.push({ op: "delete", path: "elements/" + doc.id, if_match: doc.sha256 }); removing.add(doc.id); }
    for (let index = writes.length - 1; index >= 0; index--) { const data = writes[index].data; if (writes[index].op === "set" && data?.type === "arrow" && !whole(data)) writes.splice(index, 1); }
    if (writes.length) {
      // Deletions (arrows first), then sections, then content, then arrows once both ends exist; a conflict leaves everything as is until the next sync.
      const isArrow = (write: (typeof writes)[number]) => (write.data?.type ?? docs.get(write.path.split("/")[1])?.data.type) === "arrow";
      const rank = (write: (typeof writes)[number]) => write.op === "delete" ? (isArrow(write) ? 0 : 1) : write.data?.type === "container" ? 2 : isArrow(write) ? 4 : 3;
      writes.sort((a, b) => rank(a) - rank(b));
      for (let start = 0; start < writes.length; start += 200) engine.write(root, writes.slice(start, start + 200));
      const after = new Map(((engine.read(root, "elements") as { docs?: Doc[] }).docs ?? []).map(doc => [doc.id, doc]));
      for (const write of writes) {
        const id = write.path.split("/")[1];
        if (write.op === "delete") { delete written[id]; link.published = link.published.filter(item => item !== id); continue; }
        const doc = after.get(id); if (doc) written[id] = doc.sha256;
        if (!link.published.includes(id)) link.published.push(id);
      }
    }
    link.lastSyncedAt = Date.now();
    const file = path.join(root, "meeting-links.json");
    await writeFile(file + ".tmp", JSON.stringify(link), { mode: 0o600 }); await rename(file + ".tmp", file);
  }
  async read(id: string): Promise<BoardRead> {
    const engine = await this.getEngine();
    const root = this.root(id);
    const result = engine.read(root,"elements") as {docs?: BoardRead["documents"]};
    const documents = result.docs ?? [];
    const raw = await engine.context(root) as { at?: string | number; context?: unknown } | null;
    const context = raw?.context && typeof raw.context === "object" ? raw.context as Record<string,unknown> : {};
    const revision = createHash("sha256").update(JSON.stringify({ documents, context: { selected: context.selected ?? [], editing: context.editing ?? null } })).digest("hex");
    return { meetingId:id,revision,observedAt:Date.now(),documents,selection:raw?.context ?? null,selectionAt:typeof raw?.at === "string" || typeof raw?.at === "number" ? raw.at : null,error:null };
  }
  /** Just the editor selection, cheap enough to poll so the page can jump to a card's cited speech. */
  async selection(id: string): Promise<{ selected: string[]; at: string | number | null }> {
    const raw = await (await this.getEngine()).context(this.root(id)) as { at?: string | number; context?: { selected?: unknown } } | null;
    const picked = raw?.context?.selected;
    const selected = Array.isArray(picked) ? picked.filter((value): value is string => typeof value === "string") : [];
    return { selected, at: typeof raw?.at === "string" || typeof raw?.at === "number" ? raw.at : null };
  }
  async write(id: string, writes: unknown[]): Promise<BoardRead> {
    if (!writes.length || writes.length > 50 || JSON.stringify(writes).length > 200000) throw Error("一次最多修改50项，且不超过200KB");
    for (const raw of writes) {
      if (!raw || typeof raw !== "object") throw Error("白板操作格式不正确");
      const w = raw as Record<string, unknown>;
      if (!["set","delete"].includes(String(w.op)) || typeof w.path !== "string" || !/^elements\/[a-zA-Z0-9_-]+$/.test(w.path) || !("if_match" in w) || w.if_match === "*") throw Error("白板写入需要元素路径和读取时的版本，请先读取白板");
      if (w.data && typeof w.data === "object" && ["html","image","link"].includes(String((w.data as Record<string, unknown>).type))) throw Error("初版只支持文本、便签、形状、箭头等本地元素");
    }
    const next = this.queue.then(async () => { (await this.getEngine()).write(this.root(id), writes); return this.read(id); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  close(): Promise<void> {
    this.closing=true;
    this.closeTask ??= (async()=>{
      await this.queue.catch(()=>undefined);
      await Promise.allSettled([...this.openings]);
      const engine=this.engine ?? await this.engineStarting?.catch(()=>null);
      await engine?.stop();this.engine=null;
    })();
    return this.closeTask;
  }
}
