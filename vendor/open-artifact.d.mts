/** Public declaration for the meeting plugin's narrow vendor adapter. */
export interface BoardEngine {
  open(root: string, title: string): Promise<string>;
  read(root: string, path: string): unknown;
  write(root: string, writes: unknown[]): unknown;
  context(root: string): Promise<unknown>;
  stop(): Promise<void>;
}
export function startBoardEngine(assetsDir: string): Promise<BoardEngine>;
