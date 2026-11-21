/**
 * Carries out work requested during a meeting with an agent installed on this computer, run from its command line:
 * Codex (codex exec), Claude Code (claude -p) or Cursor (cursor-agent -p). Each task is one non-interactive run;
 * its final answer is the result shown on the meeting page.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Generate } from "../server/summary";

export type RunnerName = "codex" | "claude" | "cursor";
/** args: a task run (may edit files and run commands). organise: a text-only answer, used as the organising model. */
type Spec = { bin: string; stdin: boolean; args: (cwd: string, lastMessage: string) => string[]; organise: (cwd: string, lastMessage: string, model: string[]) => string[] };
const SPECS: Record<RunnerName, Spec> = {
  // The prompt goes through stdin where the CLI supports it, so it never passes through a shell.
  codex: { bin: "codex", stdin: true, args: (cwd, lastMessage) => ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "-o", lastMessage, "-"],
    organise: (cwd, lastMessage, model) => ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "model_reasoning_effort=\"low\"", ...model, "-C", cwd, "-o", lastMessage, "-"] },
  claude: { bin: "claude", stdin: true, args: () => ["-p", "--dangerously-skip-permissions", "--output-format", "text"], organise: (_cwd, _lastMessage, model) => ["-p", "--output-format", "text", ...model] },
  cursor: { bin: "cursor-agent", stdin: false, args: cwd => ["-p", "--force", "--trust", "--output-format", "text", "--workspace", cwd], organise: (cwd, _lastMessage, model) => ["-p", "--trust", "--output-format", "text", ...model, "--workspace", cwd] },
};
const windows = process.platform === "win32";
/** Absolute path of a command on PATH, or null. */
export function locate(bin: string): string | null {
  try { return execFileSync(windows ? "where" : "which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).find(Boolean)?.trim() || null; } catch { return null; }
}
/** "auto" picks the first installed of Codex, Claude Code, Cursor; "off" disables. */
export function pickRunner(choice: string | undefined, find = locate): { name: RunnerName; path: string } | null {
  const wanted = (choice || "auto").toLowerCase();
  if (wanted === "off" || wanted === "none") return null;
  const order: RunnerName[] = wanted === "auto" ? ["codex", "claude", "cursor"] : [wanted as RunnerName];
  for (const name of order) {
    const spec = SPECS[name]; if (!spec) continue;
    const found = find(spec.bin);
    // A .cmd shim needs a shell on Windows; only CLIs that read the prompt from stdin may go through one.
    if (found && (!windows || spec.stdin || /\.exe$/i.test(found))) return { name, path: found };
  }
  return null;
}
type Run = { child: ChildProcess; status: "running" | "completed" | "failed"; output: string; error: string };
export type ModelChoice = { id: string; label: string; isDefault: boolean };
/** Claude Code has no command that lists models; its --model accepts these documented aliases. */
const CLAUDE_ALIASES: ModelChoice[] = [{ id: "sonnet", label: "Sonnet", isDefault: false }, { id: "opus", label: "Opus", isDefault: false }, { id: "haiku", label: "Haiku", isDefault: false }];
/**
 * The models the agent CLI on this computer can use with the person's own account and configuration: Codex answers model/list
 * over its app-server protocol, Cursor prints them with "cursor-agent models", Claude Code offers its aliases. Empty when the
 * list cannot be read; the settings then fall back to typing a model name.
 */
export async function listModels(runner: { name: RunnerName; path: string }, timeoutMs = 8000, spawnFn: typeof spawn = spawn): Promise<ModelChoice[]> {
  if (runner.name === "claude") return CLAUDE_ALIASES;
  const env = { ...process.env, MEETING_ASSISTANT_TASK_RUN: "1" };
  if (runner.name === "cursor") {
    const output = await new Promise<string>(resolve => {
      const child = spawnFn(runner.path, ["models"], { shell: windows && /\.(cmd|bat)$/i.test(runner.path), stdio: ["ignore", "pipe", "ignore"], env });
      let text = ""; const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.on("data", chunk => { text += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); }); child.on("close", () => { clearTimeout(timer); resolve(text); });
    });
    // One model per line, "id - Display name"; headings, empty lines and notices have no plain id first.
    return output.split(/\r?\n/).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).map(line => line.match(/^([a-z0-9][\w.:\/-]*)(?:\s+[-–—]\s+(.+?))?(\s+\(default\)|\s+\(current\))?$/i)).filter((match): match is RegExpMatchArray => Boolean(match) && !/^(available|no|models?)$/i.test(match![1]))
      .map(match => ({ id: match[1], label: match[2] || match[1], isDefault: Boolean(match[3]) }));
  }
  return new Promise(resolve => {
    const child = spawnFn(runner.path, ["app-server"], { shell: windows && /\.(cmd|bat)$/i.test(runner.path), stdio: ["pipe", "pipe", "ignore"], env });
    const models: ModelChoice[] = []; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(models); };
    const timer = setTimeout(finish, timeoutMs);
    const send = (message: unknown) => child.stdin?.write(JSON.stringify(message) + "\n");
    let next = 1;
    const page = (cursor: string | null) => send({ id: ++next, method: "model/list", params: cursor ? { cursor } : {} });
    child.stdout?.setEncoding("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: { id?: number; result?: { data?: { id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }[]; nextCursor?: string | null }; error?: unknown };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { if (message.error) return finish(); send({ method: "initialized" }); page(null); continue; }
        if (typeof message.id !== "number") continue;
        if (message.error) return finish();
        for (const model of message.result?.data ?? []) if (!model.hidden && (model.model || model.id)) models.push({ id: model.model || model.id!, label: model.displayName || model.model || model.id!, isDefault: Boolean(model.isDefault) });
        if (message.result?.nextCursor && models.length < 200) page(message.result.nextCursor); else finish();
      }
    });
    child.on("error", finish); child.on("close", finish);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "meeting-assistant", version: "1" } } });
  });
}
/**
 * The agent CLI as the organising model, for people who have not configured an API key: one non-interactive, read-only run
 * per request that only answers with text. Runs are marked so the meeting server they load stays idle.
 */
export function cliGenerate(runner: { name: RunnerName; path: string }, cwd: string, timeoutMs = 150000, spawnFn: typeof spawn = spawn): Generate {
  const spec = SPECS[runner.name];
  // A model chosen in the settings is passed on; otherwise the CLI uses its own default.
  return ({ prompt, instructions, model }) => new Promise((resolve, reject) => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "meeting-organise-"));
    const lastMessage = path.join(scratch, "last-message.md");
    const message = instructions + "\n\n以下是本次输入（JSON）：\n" + prompt + "\n\n只按上面的要求直接给出最终回答；不要调用任何工具，不要读写文件。";
    const chosen = model ? [runner.name === "codex" ? "-m" : "--model", model] : [];
    const child = spawnFn(runner.path, [...spec.organise(cwd, lastMessage, chosen), ...(spec.stdin ? [] : [message])], { cwd, shell: windows && /\.(cmd|bat)$/i.test(runner.path), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MEETING_ASSISTANT_TASK_RUN: "1" } });
    let output = "", settled = false;
    const finish = (error: Error | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (runner.name === "codex") { try { output = readFileSync(lastMessage, "utf8"); } catch { /* fall back to what was printed */ } }
      rmSync(scratch, { recursive: true, force: true });
      if (error) reject(error); else if (!output.trim()) reject(Error(runner.name + " 没有返回整理结果")); else resolve({ text: output, model: model || runner.name });
    };
    const timer = setTimeout(() => { child.kill(); finish(Error("整理请求超时")); }, timeoutMs);
    child.stdout?.on("data", chunk => { output += chunk; if (output.length > 400000) output = output.slice(-400000); });
    child.stderr?.on("data", () => undefined);
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? null : Error(runner.name + " 整理失败（退出码 " + code + "）")));
    if (spec.stdin) child.stdin?.end(message); else child.stdin?.end();
  });
}
/** The sessions interface the meeting controller uses for background work, backed by one CLI run per task. */
export function cliSessions(runner: { name: RunnerName; path: string }, cwd: string, spawnFn: typeof spawn = spawn) {
  const runs = new Map<string, Run>();
  let next = 0;
  const spec = SPECS[runner.name];
  return {
    reply: "output" as const,
    workspace: async () => cwd,
    start: async () => "local",
    send: async (_workspace: string, _session: string, message: string) => {
      const turn = "run-" + (++next) + "-" + Date.now();
      const scratch = mkdtempSync(path.join(os.tmpdir(), "meeting-task-"));
      const lastMessage = path.join(scratch, "last-message.md");
      const args = [...spec.args(cwd, lastMessage), ...(spec.stdin ? [] : [message])];
      // Runs started for a task must not start another meeting server of their own.
      const child = spawnFn(runner.path, args, { cwd, shell: windows && /\.(cmd|bat)$/i.test(runner.path), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MEETING_ASSISTANT_TASK_RUN: "1" } });
      const run: Run = { child, status: "running", output: "", error: "" };
      runs.set(turn, run);
      child.stdout?.on("data", chunk => { run.output += chunk; if (run.output.length > 200000) run.output = run.output.slice(-200000); });
      child.stderr?.on("data", chunk => { run.error = (run.error + chunk).slice(-4000); });
      child.on("error", error => { run.status = "failed"; run.error = String(error); });
      child.on("close", code => {
        if (runner.name === "codex") { try { run.output = readFileSync(lastMessage, "utf8"); } catch { /* fall back to what was printed */ } }
        rmSync(scratch, { recursive: true, force: true });
        if (run.status === "running") run.status = code === 0 && run.output.trim() ? "completed" : "failed";
      });
      if (spec.stdin) child.stdin?.end(message); else child.stdin?.end();
      return turn;
    },
    status: async (_workspace: string, _session: string, turn: string) => runs.get(turn)?.status ?? "unavailable",
    output: async (turn: string) => runs.get(turn)?.output ?? null,
    /** Ends runs still going when the meeting server shuts down. */
    stop: () => { for (const run of runs.values()) if (run.status === "running") { run.status = "failed"; run.child.kill(); } },
  };
}

