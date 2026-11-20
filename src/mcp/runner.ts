/**
 * Carries out work requested during a meeting with an agent installed on this computer, run from its command line:
 * Codex (codex exec), Claude Code (claude -p) or Cursor (cursor-agent -p). Each task is one non-interactive run;
 * its final answer is the result shown on the meeting page.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RunnerName = "codex" | "claude" | "cursor";
type Spec = { bin: string; stdin: boolean; args: (cwd: string, lastMessage: string) => string[] };
const SPECS: Record<RunnerName, Spec> = {
  // The prompt goes through stdin where the CLI supports it, so it never passes through a shell.
  codex: { bin: "codex", stdin: true, args: (cwd, lastMessage) => ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "-o", lastMessage, "-"] },
  claude: { bin: "claude", stdin: true, args: () => ["-p", "--dangerously-skip-permissions", "--output-format", "text"] },
  cursor: { bin: "cursor-agent", stdin: false, args: cwd => ["-p", "--force", "--trust", "--output-format", "text", "--workspace", cwd] },
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

