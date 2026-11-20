import { createHash } from "node:crypto";
import { DEFAULT_TOPIC, NO_CHAPTERS, SIDE_GROUP, STATUS_GROUPS, footnote, type BoardItem, type BoardLink, type BoardSpace, type Chapters, type GroupSummary, type ItemKind, type LinkType, type Meeting } from "../shared";
import { COMPACT_ITEMS_PER_GROUP } from "./summary";

export type BoardElement = Record<string, unknown>;

/*
 * Stable layout: groups take columns left to right in the order they first appeared and entries stack
 * downwards in the order they were added. New content only appears at the right edge or the bottom of a
 * column, so nothing people are reading moves. Positions are recomputed from the ledger each sync, which
 * yields the same coordinates for the same entries.
 */
export const TINT = { paper: "#f3f1ec", green: "#dcf2e4", peach: "#ffe6d5", lavender: "#ebe5fa", white: "#ffffff" } as const;
const STYLE: Record<ItemKind, { label: string | null; color: string; stroke?: string }> = {
  point: { label: null, color: TINT.paper },
  proposal: { label: "方案", color: TINT.white, stroke: "blue" },
  risk: { label: "风险", color: TINT.white, stroke: "terracotta" },
  decision: { label: "结论", color: TINT.green },
  action: { label: "待办", color: TINT.peach },
  question: { label: "待确认", color: TINT.lavender },
  step: { label: null, color: TINT.paper },
  status: { label: null, color: TINT.paper },
  cell: { label: null, color: TINT.paper },
};
const STATUS_TINT: Record<string, string> = { 已完成: TINT.green, 进行中: TINT.paper, 受阻: TINT.lavender, 下一步: TINT.peach };
const RELATION: Record<LinkType, { label: string; color: string; dash?: boolean; head?: string }> = {
  causes: { label: "导致", color: "ink" },
  supports: { label: "支持", color: "green", dash: true },
  opposes: { label: "分歧", color: "terracotta", dash: true, head: "both" },
  resolves: { label: "回应", color: "green" },
  leads_to: { label: "落实为", color: "ink" },
  depends: { label: "依赖", color: "blue", dash: true },
};
const LEFT = 80, TOP = 220, COL_W = 420, COL_GAP = 96, PAD = 20, CARD_GAP = 18;
/** Narrow screens: the whole board is laid out within about 900 units, so it fits a side panel at a readable size. */
const COMPACT_W = 820, COMPACT_COL_W = 360;
/** Cards a mind-map topic shows at most; the rest stays in the ledger (Q&A, export) and is counted under the branch. */
const MINDMAP_LEAVES = 8;

const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
export const elementId = (item: Pick<BoardItem, "id">) => "it-" + item.id;
export const groupElementId = (group: string) => "grp-" + key(group);
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => String(n).split("").map(digit => SUP[Number(digit)]).join("");
/** Footnote marks pointing at the numbered lines of the live transcript; selecting the card shows them. */
const marks = (refs: string[]) => refs.length ? " " + refs.slice(0, 3).map(id => sup(footnote(id))).join("˒") + (refs.length > 3 ? "⁺" : "") : "";

function textHeight(text: string, w: number): number {
  const perLine = Math.max(4, Math.floor((w - 32) / 16));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line.replace(/\*\*/g, "")].length / perLine)), 0);
  return Math.max(64, 28 + lines * 24);
}
function cardText(item: BoardItem): string {
  const style = STYLE[item.kind];
  let body = item.text;
  if (item.kind === "step") { const [name, ...rest] = item.text.split(/[：:]/); body = rest.length ? "**" + name + "**\n" + rest.join("：") : "**" + item.text + "**"; }
  if (item.kind === "status" && item.owner) body = "**" + item.owner + "**　" + item.text;
  const lines = [(style.label ? "**" + style.label + "**　" : "") + body + marks(item.refs)];
  if (item.kind === "action" && (item.owner || item.due)) lines.push((item.owner ? "负责人 " + item.owner : "负责人待定") + (item.due ? " · " + item.due : ""));
  return lines.join("\n");
}
function card(item: BoardItem, x: number, y: number, w: number): BoardElement {
  const style = STYLE[item.kind]; const text = cardText(item);
  const color = item.kind === "status" ? STATUS_TINT[item.group] ?? TINT.paper : style.color;
  return { type: "shape", kind: "rounded", color, ...(style.stroke ? { stroke: style.stroke } : {}), x, y, w, h: textHeight(text, w), text, size: "body", textAlign: "left", by: "agent" };
}
/** A titled column of cards; returns its bottom edge. Used by the progress board and the side column. */
function column(out: Map<string, BoardElement>, group: string, title: string, items: BoardItem[], x: number, y: number, w = COL_W): number {
  let cursor = y + PAD;
  const cards: [string, BoardElement][] = items.map(item => { const element = card(item, x + PAD, cursor, w - PAD * 2); cursor += (element.h as number) + CARD_GAP; return [elementId(item), element]; });
  const bottom = items.length ? cursor - CARD_GAP + PAD : y + 64;
  out.set(groupElementId(group), { type: "container", x, y, w, h: bottom - y, text: title, by: "agent" });
  for (const [id, element] of cards) out.set(id, element);
  return bottom;
}
const groupsInOrder = (items: BoardItem[]) => [...new Set(items.map(item => item.group))];
const byGroup = (items: BoardItem[], group: string) => items.filter(item => item.group === group);

/*
 * Topic column, read top to bottom: heading, the group's one-line status, the outcomes (conclusions, actions, open
 * questions) as cards, then the discussion folded into a few compact blocks by subtopic. Each line keeps its footnote.
 */
const OUTCOMES: ItemKind[] = ["decision", "action", "question"];
const FALLBACK_SUB: Partial<Record<ItemKind, string>> = { proposal: "提出的方案", risk: "风险与顾虑" };
export const subOf = (item: BoardItem) => item.sub || FALLBACK_SUB[item.kind] || "讨论要点";
export const blockId = (first: BoardItem) => "blk-" + first.id;
export const summaryId = (first: BoardItem) => "sum-" + first.id;
const LINE_LABEL: Partial<Record<ItemKind, string>> = { proposal: "方案", risk: "风险" };
function bullet(item: BoardItem, sub: string): string {
  const label = LINE_LABEL[item.kind];
  return "• " + (label && !sub.includes(label) ? "**" + label + "** " : "") + item.text + marks(item.refs);
}
const HEAD_H = 46;
/** Where a topic stands as a chapter: the one being discussed, wrapped up and frozen, or neither (older meetings, other forms). */
export type ChapterState = "active" | "closed" | null;
const CHAPTER_TAG: Record<"active" | "closed", string> = { active: "**讨论中**　", closed: "**小结**　" };
function topicColumn(out: Map<string, BoardElement>, group: string, items: BoardItem[], summary: GroupSummary | undefined, x: number, y: number, w = COL_W, state: ChapterState = null, folded = 0): void {
  const inner = w - PAD * 2;
  out.set("grp-h-" + items[0].id, { type: "text", x: x + PAD, y: y + PAD, wrap: inner, text: group || DEFAULT_TOPIC, size: "large", color: "ink", by: "agent" });
  let cursor = y + PAD + HEAD_H;
  if (summary) {
    const text = (state ? CHAPTER_TAG[state] : "") + summary.text + marks(summary.refs); const h = textHeight(text, inner);
    out.set(summaryId(items[0]), { type: "shape", kind: "rounded", color: TINT.white, stroke: "ink", x: x + PAD, y: cursor, w: inner, h, text, size: "body", textAlign: "left", by: "agent" });
    cursor += h + CARD_GAP;
  }
  for (const item of items.filter(entry => OUTCOMES.includes(entry.kind))) { const element = card(item, x + PAD, cursor, inner); out.set(elementId(item), element); cursor += (element.h as number) + CARD_GAP; }
  const discussion = items.filter(entry => !OUTCOMES.includes(entry.kind));
  for (const sub of [...new Set(discussion.map(subOf))]) {
    const lines = discussion.filter(entry => subOf(entry) === sub);
    const text = "**" + sub + "**\n" + lines.map(entry => bullet(entry, sub)).join("\n"); const h = textHeight(text, inner);
    out.set(blockId(lines[0]), { type: "shape", kind: "rounded", color: TINT.paper, x: x + PAD, y: cursor, w: inner, h, text, size: "body", textAlign: "left", by: "agent" });
    cursor += h + CARD_GAP;
  }
  if (folded) { out.set("fold-" + items[0].id, { type: "text", x: x + PAD, y: cursor, wrap: inner, text: "已收起 " + folded + " 条细节，问答和导出中仍可查到", size: "small", color: "ink", by: "agent" }); cursor += 28 + CARD_GAP; }
  out.set(groupElementId(group), { type: "container", x, y, w, h: cursor - CARD_GAP + PAD - y, text: "", by: "agent" });
}
function topics(out: Map<string, BoardElement>, items: BoardItem[], summaries: GroupSummary[], top = TOP, chapters: Chapters = NO_CHAPTERS, hidden: BoardItem[] = []): string[] {
  return topicGrid(out, items, summaries, top, chapters, hidden, Infinity, COL_W);
}
/** Topic columns left to right; with a row limit they wrap, each row starting below the tallest column of the row above. */
function topicGrid(out: Map<string, BoardElement>, items: BoardItem[], summaries: GroupSummary[], top: number, chapters: Chapters, hidden: BoardItem[], perRow: number, width: number): string[] {
  const groups = groupsInOrder(items);
  const stateOf = (group: string): ChapterState => chapters.closed.includes(group) ? "closed" : chapters.active === group || chapters.closing === group ? "active" : null;
  let rowTop = top, rowBottom = top;
  groups.forEach((group, index) => {
    const column = index % perRow;
    if (index && column === 0) rowTop = rowBottom + COL_GAP;
    topicColumn(out, group, byGroup(items, group), summaries.find(summary => summary.group === group), LEFT + column * (width + COL_GAP), rowTop, width, stateOf(group), hidden.filter(item => item.group === group).length);
    rowBottom = Math.max(rowBottom, rowTop + (out.get(groupElementId(group))!.h as number));
  });
  return groups;
}
/** What a topic shows within its card budget: every conclusion, action and open question first, then the latest discussion. */
function withinBudget(list: BoardItem[], cap: number): { shown: BoardItem[]; over: number } {
  if (list.length <= cap) return { shown: list, over: 0 };
  const outcomes = list.filter(item => OUTCOMES.includes(item.kind)).slice(-cap);
  const room = cap - outcomes.length;
  const discussion = room > 0 ? list.filter(item => !OUTCOMES.includes(item.kind)).slice(-room) : [];
  const keep = new Set([...outcomes, ...discussion].map(item => item.id));
  return { shown: list.filter(item => keep.has(item.id)), over: list.length - keep.size };
}
/*
 * Mind map, read left to right: meeting theme -> topics (one branch per topic, in the order they were first discussed)
 * -> viewpoints under each topic, in the order they were added. Each branch has its own colour; a viewpoint's label
 * and tint say what kind it is (conclusion, action, open question, risk, proposal). New content only extends the
 * bottom of a branch or adds a branch below, so what people already read keeps its relative place.
 */
const BRANCH: string[] = ["blue", "green", "purple", "terracotta"];
const MM_CENTER_W = 240, MM_TOPIC_W = 250, MM_LEAF_W = 360, MM_GAP_X = 72, MM_LEAF_GAP = 10, MM_BLOCK_GAP = 36;
export const topicNodeId = (group: string) => "mm-t-" + key(group);
/** Viewpoints are short sentences: a compact card, two lines for most of them. */
function leafHeight(text: string, w: number): number {
  const perLine = Math.max(4, Math.floor((w - 32) / 16));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line.replace(/\*\*/g, "")].length / perLine)), 0);
  return Math.max(46, 22 + lines * 24);
}
/**
 * Balanced mind map: topics alternate right and left of the centre (first topic on the right), viewpoints extend
 * outwards from their topic in the order they were added. Which side a topic is on never changes; a branch only grows
 * at its own end, so readers keep their place while the meeting goes on.
 */
type Branch = { group: string; index: number; right: boolean; topicText: string; topicH: number; leaves: { item: BoardItem; text: string; h: number }[]; folded: number; leavesH: number; blockH: number; state: string };
/** One topic of a mind map, measured for the given widths and limited to its card budget. */
function branches(items: BoardItem[], summaries: GroupSummary[], chapters: Chapters, hidden: BoardItem[], topicW: number, leafW: number, cap: number): Branch[] {
  return groupsInOrder(items).map((group, index) => {
    const { shown, over } = withinBudget(byGroup(items, group), cap);
    const leaves = shown.map(item => { const text = cardText(item); return { item, text, h: leafHeight(text, leafW) }; });
    const folded = hidden.filter(item => item.group === group).length + over;
    const leavesH = leaves.reduce((sum, leaf) => sum + leaf.h, 0) + Math.max(0, leaves.length - 1) * MM_LEAF_GAP + (folded ? 28 + MM_LEAF_GAP : 0);
    const state = chapters.closed.includes(group) ? "已小结" : chapters.active === group || chapters.closing === group ? "讨论中" : "";
    const summary = summaries.find(entry => entry.group === group);
    const topicText = "**" + (group || DEFAULT_TOPIC) + "**" + (state ? "　" + state : "") + (summary ? "\n" + summary.text + marks(summary.refs) : "");
    const topicH = leafHeight(topicText, topicW);
    return { group, index, right: index % 2 === 0, topicText, topicH, leaves, folded, leavesH, blockH: Math.max(topicH, leavesH), state };
  });
}
const foldNote = (count: number) => "已收起 " + count + " 条细节，问答和导出中仍可查到";
function mindmap(out: Map<string, BoardElement>, items: BoardItem[], summaries: GroupSummary[], center: string, chapters: Chapters = NO_CHAPTERS, hidden: BoardItem[] = []): void {
  const centerX = LEFT + MM_LEAF_W + MM_GAP_X + MM_TOPIC_W + MM_GAP_X;
  const blocks = branches(items, summaries, chapters, hidden, MM_TOPIC_W, MM_LEAF_W, MINDMAP_LEAVES);
  const sideH = (right: boolean) => { const list = blocks.filter(block => block.right === right); return list.reduce((sum, block) => sum + block.blockH, 0) + Math.max(0, list.length - 1) * MM_BLOCK_GAP; };
  const height = Math.max(84, sideH(true), sideH(false));
  const centerText = center || "会议主题";
  const centerH = Math.max(84, leafHeight(centerText, MM_CENTER_W));
  out.set("mm-center", { type: "shape", kind: "pill", color: TINT.white, stroke: "ink", x: centerX, y: TOP + (height - centerH) / 2, w: MM_CENTER_W, h: centerH, text: centerText, size: "large", by: "agent" });
  for (const right of [true, false]) {
    let cursor = TOP + (height - sideH(right)) / 2;
    const topicX = right ? centerX + MM_CENTER_W + MM_GAP_X : centerX - MM_GAP_X - MM_TOPIC_W;
    const leafX = right ? topicX + MM_TOPIC_W + MM_GAP_X : topicX - MM_GAP_X - MM_LEAF_W;
    const inner = right ? "right" : "left", outer = right ? "left" : "right";
    for (const block of blocks.filter(entry => entry.right === right)) {
      const color = BRANCH[block.index % BRANCH.length];
      const topicId = topicNodeId(block.group);
      out.set(topicId, { type: "shape", kind: "rounded", color: block.state === "已小结" ? TINT.paper : TINT.white, stroke: color, x: topicX, y: cursor + (block.blockH - block.topicH) / 2, w: MM_TOPIC_W, h: block.topicH, text: block.topicText, size: "body", textAlign: "left", by: "agent" });
      out.set("mm-a-" + key(block.group), { type: "arrow", from: "mm-center", to: topicId, fromSide: inner, toSide: outer, head: "none", color, by: "agent" });
      let y = cursor + (block.blockH - block.leavesH) / 2;
      for (const leaf of block.leaves) {
        const style = STYLE[leaf.item.kind];
        out.set(elementId(leaf.item), { type: "shape", kind: "rounded", color: leaf.item.kind === "status" ? STATUS_TINT[leaf.item.group] ?? TINT.paper : style.color, ...(style.stroke ? { stroke: style.stroke } : {}), x: leafX, y, w: MM_LEAF_W, h: leaf.h, text: leaf.text, size: "body", textAlign: "left", by: "agent" });
        out.set("mm-e-" + leaf.item.id, { type: "arrow", from: topicId, to: elementId(leaf.item), fromSide: inner, toSide: outer, head: "none", color, by: "agent" });
        y += leaf.h + MM_LEAF_GAP;
      }
      if (block.folded) out.set("fold-" + items.find(item => item.group === block.group)!.id, { type: "text", x: leafX, y, wrap: MM_LEAF_W, text: foldNote(block.folded), size: "small", color: "ink", by: "agent" });
      cursor += block.blockH + MM_BLOCK_GAP;
    }
  }
}
/*
 * Mind map for a narrow screen: the theme on the left, topics in one column to its right and their viewpoints in the next
 * column, each topic below the previous one. About 900 units wide, read top to bottom, and at most
 * COMPACT_ITEMS_PER_GROUP cards per topic.
 */
const MMC_CENTER_W = 190, MMC_TOPIC_W = 220, MMC_LEAF_W = 300, MMC_GAP_X = 44;
function mindmapCompact(out: Map<string, BoardElement>, items: BoardItem[], summaries: GroupSummary[], center: string, chapters: Chapters, hidden: BoardItem[]): void {
  const topicX = LEFT + MMC_CENTER_W + MMC_GAP_X, leafX = topicX + MMC_TOPIC_W + MMC_GAP_X;
  const centerText = center || "会议主题";
  out.set("mm-center", { type: "shape", kind: "pill", color: TINT.white, stroke: "ink", x: LEFT, y: TOP, w: MMC_CENTER_W, h: Math.max(64, leafHeight(centerText, MMC_CENTER_W)), text: centerText, size: "large", by: "agent" });
  let cursor = TOP;
  for (const block of branches(items, summaries, chapters, hidden, MMC_TOPIC_W, MMC_LEAF_W, COMPACT_ITEMS_PER_GROUP)) {
    const color = BRANCH[block.index % BRANCH.length];
    const topicId = topicNodeId(block.group);
    out.set(topicId, { type: "shape", kind: "rounded", color: block.state === "已小结" ? TINT.paper : TINT.white, stroke: color, x: topicX, y: cursor, w: MMC_TOPIC_W, h: block.topicH, text: block.topicText, size: "body", textAlign: "left", by: "agent" });
    out.set("mm-a-" + key(block.group), { type: "arrow", from: "mm-center", to: topicId, fromSide: "right", toSide: "left", head: "none", color, by: "agent" });
    let y = cursor;
    for (const leaf of block.leaves) {
      const style = STYLE[leaf.item.kind];
      out.set(elementId(leaf.item), { type: "shape", kind: "rounded", color: leaf.item.kind === "status" ? STATUS_TINT[leaf.item.group] ?? TINT.paper : style.color, ...(style.stroke ? { stroke: style.stroke } : {}), x: leafX, y, w: MMC_LEAF_W, h: leaf.h, text: leaf.text, size: "body", textAlign: "left", by: "agent" });
      out.set("mm-e-" + leaf.item.id, { type: "arrow", from: topicId, to: elementId(leaf.item), fromSide: "right", toSide: "left", head: "none", color, by: "agent" });
      y += leaf.h + MM_LEAF_GAP;
    }
    if (block.folded) out.set("fold-" + items.find(item => item.group === block.group)!.id, { type: "text", x: leafX, y, wrap: MMC_LEAF_W, text: foldNote(block.folded), size: "small", color: "ink", by: "agent" });
    cursor += block.blockH + MM_BLOCK_GAP;
  }
}
const SIDE_X = LEFT + 1720;
/** Steps in rows; returns the bottom edge of the last row. */
function flow(out: Map<string, BoardElement>, items: BoardItem[], PER_ROW = 5): number {
  const STEP_W = 260, SPAN = 72;
  const steps = items.filter(item => item.kind === "step");
  let rowTop = TOP, rowHeight = 0;
  steps.forEach((step, index) => {
    if (index && index % PER_ROW === 0) { rowTop += rowHeight + 96; rowHeight = 0; }
    const element = card(step, LEFT + (index % PER_ROW) * (STEP_W + SPAN), rowTop, STEP_W);
    element.text = "**" + (index + 1) + "** · " + element.text;
    out.set(elementId(step), element); rowHeight = Math.max(rowHeight, element.h as number);
    if (index) out.set("fl-" + steps[index - 1].id + "-" + step.id, { type: "arrow", from: elementId(steps[index - 1]), to: elementId(step), ...(index % PER_ROW === 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "right", toSide: "left" }), color: "ink", by: "agent" });
  });
  return rowTop + rowHeight;
}
/** Progress columns; with a row limit they wrap. Returns the bottom edge. */
function status(out: Map<string, BoardElement>, items: BoardItem[], perRow = 4): number {
  let rowTop = TOP, rowBottom = TOP;
  STATUS_GROUPS.forEach((group, index) => {
    if (index && index % perRow === 0) rowTop = rowBottom + 40;
    rowBottom = Math.max(rowBottom, column(out, group, group, items.filter(item => item.kind === "status" && item.group === group), LEFT + (index % perRow) * (340 + 40), rowTop, 340));
  });
  return rowBottom;
}
function matrix(out: Map<string, BoardElement>, items: BoardItem[]): void {
  const cells = items.filter(item => item.kind === "cell");
  const options = groupsInOrder(cells); const criteria = [...new Set(cells.map(cell => cell.criterion ?? "其他"))];
  if (!options.length) return;
  const width = (texts: string[]) => Math.min(300, Math.max(120, 30 + 16 * Math.max(...texts.map(text => [...text].length))));
  const cols: Record<string, { at: number; w: number }> = { c0: { at: 1, w: width(["比较维度", ...criteria]) } };
  options.forEach((option, index) => { cols["c" + (index + 1)] = { at: index + 2, w: width([option, ...cells.filter(cell => cell.group === option).map(cell => cell.text + "  ¹²")]) }; });
  const rows: Record<string, Record<string, string | number>> = { r0: { at: 1, c0: "比较维度", ...Object.fromEntries(options.map((option, index) => ["c" + (index + 1), option])) } };
  criteria.forEach((criterion, row) => {
    rows["r" + (row + 1)] = { at: row + 2, c0: criterion, ...Object.fromEntries(options.map((option, index) => { const cell = cells.find(item => item.group === option && (item.criterion ?? "其他") === criterion); return ["c" + (index + 1), cell ? cell.text + marks(cell.refs) : "—"]; })) };
  });
  out.set("mx-table", { type: "table", x: LEFT, y: TOP, cols, rows, by: "agent" });
}

function side(out: Map<string, BoardElement>, items: BoardItem[], x: number, y = TOP): void {
  const rest = items.filter(item => item.group === SIDE_GROUP);
  if (rest.length) column(out, SIDE_GROUP, "要点与结论", rest, x, y);
}

/** Arrow ends chosen so a relation never runs through other cards: across columns side to side, within a column around its right edge, between the side column and the flow over the top of the steps. */
function arrowSides(a: BoardElement, b: BoardElement, overTop: boolean): { fromSide: string; toSide: string } {
  if (overTop) return { fromSide: "top", toSide: "top" };
  const ax = a.x as number, aw = a.w as number, bx = b.x as number, bw = b.w as number;
  if (bx >= ax + aw) return { fromSide: "right", toSide: "left" };
  if (bx + bw <= ax) return { fromSide: "left", toSide: "right" };
  return { fromSide: "right", toSide: "right" };
}
function relations(out: Map<string, BoardElement>, links: BoardLink[], items: BoardItem[]): void {
  const kindOf = (id: string) => items.find(item => item.id === id);
  // Discussion lines live inside a block, so a relation ends on the block; two lines in the same block need no arrow.
  const host = (id: string): string | null => { if (out.has("it-" + id)) return "it-" + id; const item = kindOf(id); if (!item) return null; const first = items.find(entry => entry.group === item.group && !OUTCOMES.includes(entry.kind) && subOf(entry) === subOf(item)); return first && out.has(blockId(first)) ? blockId(first) : null; };
  for (const link of links) {
    const fromId = host(link.from), toId = host(link.to);
    if (!fromId || !toId || fromId === toId) continue;
    const from = out.get(fromId)!, to = out.get(toId)!;
    const style = RELATION[link.type];
    const a = kindOf(link.from), b = kindOf(link.to);
    const bottom = (a?.kind === "step") !== (b?.kind === "step"); // between the flow row and the side column
    out.set("ln-" + link.id, { type: "arrow", from: fromId, to: toId, ...arrowSides(from, to, bottom), label: link.label || style.label, color: style.color, ...(style.dash ? { dash: true } : {}), ...(style.head ? { head: style.head } : {}), by: "agent" });
  }
}

/**
 * The board the plugin wants to show. Nothing but the title appears until the model has judged the meeting and chosen a form.
 * "compact" lays everything out within about 900 units for narrow screens: one-sided mind map, wrapped columns, side notes below.
 */
export function layoutBoard(meeting: Meeting, removed: ReadonlySet<string> = new Set(), space: BoardSpace = "normal"): Map<string, BoardElement> {
  const out = new Map<string, BoardElement>();
  const compact = space === "compact";
  out.set("meeting-title", { type: "text", x: LEFT, y: 40, wrap: compact ? COMPACT_W : 1600, text: meeting.title, size: "title", color: "ink", by: "agent" });
  const plan = meeting.plan;
  if (plan?.theme) out.set("meeting-theme", { type: "text", x: LEFT, y: 118, wrap: compact ? COMPACT_W : 1600, text: "主题：" + plan.theme, size: "large", color: "ink", by: "agent" });
  if (!plan) return out;
  const shown = meeting.items.filter(item => !removed.has(elementId(item))); // people deleted it; the rest closes up
  // Details folded when their topic was wrapped up stay in the ledger (Q&A, export) but leave the board.
  const folded = plan.form === "topics" || plan.form === "mindmap" ? shown.filter(item => item.folded) : [];
  const items = shown.filter(item => !folded.includes(item));
  const chapters = meeting.chapters ?? NO_CHAPTERS;
  const center = plan.center || plan.theme.slice(0, 16);
  if (compact) switch (plan.form) {
    case "topics": topicGrid(out, items, meeting.summaries ?? [], TOP, chapters, folded, 2, COMPACT_COL_W); break;
    case "mindmap": mindmapCompact(out, items.filter(item => item.group !== SIDE_GROUP), meeting.summaries ?? [], center, chapters, folded); break;
    case "flow": side(out, items, LEFT, flow(out, items, 2) + 96); break;
    case "status": side(out, items, LEFT, status(out, items, 2) + 64); break;
    case "matrix": matrix(out, items); side(out, items, LEFT, TOP + (new Set(items.filter(item => item.kind === "cell").map(cell => cell.criterion ?? "其他")).size + 1) * 84 + 64); break;
  } else switch (plan.form) {
    case "topics": topics(out, items, meeting.summaries ?? [], TOP, chapters, folded); break;
    case "mindmap": mindmap(out, items.filter(item => item.group !== SIDE_GROUP), meeting.summaries ?? [], center, chapters, folded); break;
    case "flow": flow(out, items); side(out, items, SIDE_X, TOP + 72); break; // below the lane where relations cross over the steps
    case "status": status(out, items); side(out, items, LEFT + 4 * 380 + 40); break;
    case "matrix": matrix(out, items); side(out, items, SIDE_X); break;
  }
  // A mind map is a tree: its branches already show how viewpoints belong together, so cross links stay in the data (Q&A, export) and off the board.
  if (plan.form !== "mindmap") relations(out, meeting.links, items);
  return out;
}
