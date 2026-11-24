import http, { type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MeetingController } from "./controller";
import type { MeetingBoards } from "./board";
export class MeetingBrowser {
  private server: Server | null = null;
  private base = "";
  private tokens = new Map<string,string>();
  /** When each meeting's page last asked for its state; the page polls every second while it is open. */
  private seen = new Map<string,number>();
  /** The moment a time link asked each meeting's open page to show; the nonce tells the page a new request from an old one. */
  private focus = new Map<string,{ atMs: number; nonce: number }>();
  private focusCount = 0;
  /** models: the models the page's settings can offer for proofreading; empty means the model name is typed. */
  constructor(private readonly controller: MeetingController, private readonly boards: MeetingBoards, private readonly htmlFile: string, private readonly boardError: (id: string) => string | null = () => null, private readonly htmlTransform: (html: string) => string = html => html, private readonly models: () => Promise<{ id: string; label: string; isDefault: boolean }[]> = async () => []) {}
  /** Whether a meeting's page is open somewhere (polled within the last few seconds). */
  showing(id: string, withinMs = 6000): boolean { return Date.now() - (this.seen.get(id) ?? 0) <= withinMs; }
  async open(id: string): Promise<string> {
    if (!this.server) {
      const server = http.createServer((request,response) => { void (async () => {
        response.setHeader("Cache-Control","no-store");
        response.setHeader("Referrer-Policy","no-referrer");
        response.setHeader("X-Content-Type-Options","nosniff");
        if (request.headers.host !== new URL(this.base).host) { response.writeHead(403); response.end(); return; }
        const origin = request.headers.origin;
        if (origin && origin !== this.base) { response.writeHead(403); response.end(); return; }
        const url = new URL(request.url ?? "/",this.base);
        const match = url.pathname.match(/^\/meeting\/([a-f0-9]{48})\/(api(?:\/selection|\/settings|\/meetings)?)?$/);
        const meetingId = match ? this.tokens.get(match[1]) : null;
        if (!meetingId) { response.writeHead(404); response.end(); return; }
        if (request.method === "GET" && !match?.[2]) {
          response.setHeader("Content-Type","text/html;charset=utf-8");
          response.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'");
          // A time link from the conversation (?at=seconds) opens a new tab in the side browser. When this meeting's page is
          // already open there, that page jumps to the moment and the new tab closes itself, so the side browser keeps one
          // meeting page. Otherwise this tab shows the meeting and jumps there itself.
          const at = Number(url.searchParams.get("at"));
          if (url.searchParams.has("at") && Number.isFinite(at) && at >= 0 && this.showing(meetingId, 3000)) {
            this.focus.set(meetingId, { atMs: Math.round(at * 1000), nonce: ++this.focusCount });
            response.end(jumpPage(url.pathname, at)); return;
          }
          response.end(this.htmlTransform(await readFile(this.htmlFile, "utf8"))); return;
        }
        response.setHeader("Content-Type","application/json;charset=utf-8");
        if (request.method === "GET" && match?.[2] === "api/settings") { const [environment, models] = await Promise.all([this.controller.check(), this.models().catch(() => [])]); response.end(JSON.stringify({ settings: this.controller.snapshot().settings, environment, models })); return; }
        if (request.method === "GET" && match?.[2] === "api/meetings") { const snapshot = this.controller.snapshot(); response.end(JSON.stringify({ current: snapshot.meeting?.id ?? null, viewing: meetingId, meetings: snapshot.history })); return; }
        if (request.method === "GET" && match?.[2] === "api/selection") { response.end(JSON.stringify(await this.boards.selection(meetingId))); return; }
        if (request.method === "GET" && match?.[2]) {
          this.seen.set(meetingId, Date.now());
          const snapshot = this.controller.view(meetingId);
          const boardUrl = await this.boards.open(meetingId,snapshot.meeting!.title);
          // Content on the board besides the title, including what the conversation wrote there: the page stops showing "listening" once there is any.
          const boardItems = (await this.boards.read(meetingId).catch(() => null))?.documents.filter(doc => doc.id !== "meeting-title" && doc.id !== "meeting-theme").length ?? 0;
          response.end(JSON.stringify({ snapshot, boardUrl, boardError: this.boardError(meetingId), boardItems, boardSpace: this.controller.boardSpace(), focus: this.focus.get(meetingId) ?? null })); return;
        }
        if (request.method === "POST" && match?.[2] === "api") {
          if (origin !== this.base || !request.headers["content-type"]?.startsWith("application/json")) { response.writeHead(403);response.end();return; }
          const chunks:Buffer[]=[];let size=0;
          for await (const chunk of request) {size+=chunk.length;if(size>16384){response.writeHead(413);response.end();return;}chunks.push(chunk);}
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {action?:unknown};
          if (body.action === "settings") { await this.controller.configure((body as { settings?: unknown }).settings); response.end(JSON.stringify({ ok: true })); return; }
          if (body.action === "viewport") { this.controller.setViewport("page:" + match![1].slice(0, 12), Number((body as { width?: unknown }).width)); response.end(JSON.stringify({ ok: true, space: this.controller.boardSpace() })); return; }
          // A new meeting or another record: the page navigates to that meeting's own address.
          if (body.action === "new") { const { snapshot } = await this.controller.newMeeting(String((body as { title?: unknown }).title ?? "").slice(0, 200)); response.end(JSON.stringify({ ok: true, url: await this.open(snapshot.meeting!.id) })); return; }
          if (body.action === "switch") { const id = String((body as { id?: unknown }).id ?? ""); await this.controller.switchTo(id); response.end(JSON.stringify({ ok: true, url: await this.open(id) })); return; }
          // Minutes can be written for any meeting this page shows, including past ones.
          if (body.action === "minutes") {
            try { this.controller.requestMinutes(meetingId); response.end(JSON.stringify({ ok: true })); }
            catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : "纪要没有生成" })); }
            return;
          }
          // Minutes action items, for any meeting this page shows (see the plugin service's meeting.todo* methods).
          const todoActions: Record<string, (value: Record<string, unknown>) => Promise<unknown>> = {
            todoHand: value => this.controller.handTodo(meetingId, String(value.todo ?? "")),
            todoReplan: value => this.controller.replanTodo(meetingId, String(value.taskId ?? ""), String(value.text ?? "")),
            todoFollow: value => this.controller.followTodo(meetingId, String(value.taskId ?? ""), String(value.text ?? "")),
            todoMark: value => this.controller.markTodo(meetingId, String(value.todo ?? ""), value.done === true),
            prepRewrite: value => this.controller.rewriteTodoPrep(meetingId, String(value.todo ?? ""), String(value.text ?? "")),
          };
          const todoAction = todoActions[String(body.action)];
          if (todoAction) {
            try { await todoAction(body as Record<string, unknown>); response.end(JSON.stringify({ ok: true })); }
            catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : "操作没有完成" })); }
            return;
          }
          if (body.action === "preps") {
            try { this.controller.requestPreps(meetingId); response.end(JSON.stringify({ ok: true })); }
            catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : "没有准备成功" })); }
            return;
          }
          if (body.action === "share") {
            try { response.end(JSON.stringify(await this.controller.share(meetingId))); }
            catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : "纪要没有分享成功" })); }
            return;
          }
          // A task a scenario proposed, carried out or left, in any meeting this page shows.
          if (body.action === "taskDecide") {
            const value = body as { taskId?: unknown; run?: unknown };
            try { await this.controller.decideTask(meetingId, String(value.taskId ?? ""), value.run === true); response.end(JSON.stringify({ ok: true })); }
            catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : "操作没有完成" })); }
            return;
          }
          if (this.controller.snapshot().meeting?.id !== meetingId) throw Error("此页面不是当前录音会议，请回到对应会话");
          if (body.action === "summarize") this.controller.summarizeNow();
          else if (body.action === "retry") await this.controller.retry();
          else if (["stop","pause","resume"].includes(String(body.action))) await this.controller.control(String(body.action));
          else if (body.action === "layout") await this.controller.setLayout(meetingId, String((body as {form?:unknown}).form ?? ""), (body as {refresh?:unknown}).refresh === true);
          else throw Error("不支持的操作");
          response.end(JSON.stringify({ok:true})); return;
        }
        response.writeHead(405);response.end();
      })().catch(() => { if (!response.headersSent) response.writeHead(400,{"Content-Type":"application/json;charset=utf-8"}); response.end(JSON.stringify({error:"操作未完成，请确认会议状态或重试"})); }); });
      await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
      const address=server.address();if(!address||typeof address==="string")throw Error("无法打开会议页面");
      this.base="http://127.0.0.1:"+address.port;this.server=server;
    }
    let token = [...this.tokens].find(([,meeting])=>meeting===id)?.[0];
    if(!token){token=randomBytes(24).toString("hex");this.tokens.set(token,id);}
    return this.base+"/meeting/"+token+"/";
  }
  async close(): Promise<void> { this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server ? this.server.close(()=>resolve()) : resolve());this.server=null;this.tokens.clear(); }
}
/** The short-lived tab a time link opens while the meeting page is already showing: it closes itself; if the browser keeps it open, it becomes the meeting page at that moment. */
function jumpPage(path: string, at: number): string {
  const fallback = JSON.stringify(path + "#at=" + at);
  return "<!doctype html><meta charset=\"utf-8\"><title>正在定位会议原文</title><body style=\"font:14px system-ui;color:#6b6760;padding:24px\">已在会议页定位到这段原文。<script>window.close();setTimeout(function(){location.replace(" + fallback + ")},600)</script>";
}
