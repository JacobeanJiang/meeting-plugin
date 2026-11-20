import http, { type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MeetingController } from "./controller";
import type { MeetingBoards } from "./board";
export class MeetingBrowser {
  private server: Server | null = null;
  private base = "";
  private tokens = new Map<string,string>();
  constructor(private readonly controller: MeetingController, private readonly boards: MeetingBoards, private readonly htmlFile: string, private readonly boardError: (id: string) => string | null = () => null, private readonly htmlTransform: (html: string) => string = html => html) {}
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
          response.end(this.htmlTransform(await readFile(this.htmlFile, "utf8"))); return;
        }
        response.setHeader("Content-Type","application/json;charset=utf-8");
        if (request.method === "GET" && match?.[2] === "api/settings") { response.end(JSON.stringify({ settings: this.controller.snapshot().settings, environment: await this.controller.check() })); return; }
        if (request.method === "GET" && match?.[2] === "api/meetings") { const snapshot = this.controller.snapshot(); response.end(JSON.stringify({ current: snapshot.meeting?.id ?? null, viewing: meetingId, meetings: snapshot.history })); return; }
        if (request.method === "GET" && match?.[2] === "api/selection") { response.end(JSON.stringify(await this.boards.selection(meetingId))); return; }
        if (request.method === "GET" && match?.[2]) {
          const snapshot = this.controller.view(meetingId);
          const boardUrl = await this.boards.open(meetingId,snapshot.meeting!.title);
          response.end(JSON.stringify({ snapshot, boardUrl, boardError: this.boardError(meetingId) })); return;
        }
        if (request.method === "POST" && match?.[2] === "api") {
          if (origin !== this.base || !request.headers["content-type"]?.startsWith("application/json")) { response.writeHead(403);response.end();return; }
          const chunks:Buffer[]=[];let size=0;
          for await (const chunk of request) {size+=chunk.length;if(size>16384){response.writeHead(413);response.end();return;}chunks.push(chunk);}
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {action?:unknown};
          if (body.action === "settings") { await this.controller.configure((body as { settings?: unknown }).settings); response.end(JSON.stringify({ ok: true })); return; }
          // A new meeting or another record: the page navigates to that meeting's own address.
          if (body.action === "new") { const { snapshot } = await this.controller.newMeeting(String((body as { title?: unknown }).title ?? "").slice(0, 200)); response.end(JSON.stringify({ ok: true, url: await this.open(snapshot.meeting!.id) })); return; }
          if (body.action === "switch") { const id = String((body as { id?: unknown }).id ?? ""); await this.controller.switchTo(id); response.end(JSON.stringify({ ok: true, url: await this.open(id) })); return; }
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
