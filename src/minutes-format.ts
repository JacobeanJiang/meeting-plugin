/**
 * Meeting minutes: parse the Markdown produced with the minutes prompt into sections, and render them as
 * escaped HTML. The model never writes HTML; every character it produces is escaped, and only the
 * renderer's own tags and classes appear in the output. Unknown headings still render as plain sections,
 * so a slightly different model output degrades to readable text instead of disappearing.
 */
export type MinutesBlock =
  | { type: "h2" | "h3" | "p"; text: string }
  | { type: "li"; text: string; depth: number }
  | { type: "ol"; text: string; n: string };
export type MinutesSectionKind = "overview" | "directions" | "decisions" | "todos" | "other";
export type MinutesSection = { heading: string; kind: MinutesSectionKind; blocks: MinutesBlock[] };
export type MinutesDoc = { title: string | null; sections: MinutesSection[] };

const KIND: [RegExp, MinutesSectionKind][] = [[/会议概览|概览/, "overview"], [/核心方向/, "directions"], [/关键决策/, "decisions"], [/待办/, "todos"]];
/** Template guidance the model sometimes copies verbatim; never shown. */
const GUIDANCE = /^按核心议题、业务逻辑和篇幅重心组织|仅在原文存在明确/;
const FENCE = /^\s*```(?:markdown|md)?\s*\n?|\n?```\s*$/g;

export function parseMinutes(markdown: string): MinutesDoc {
  const doc: MinutesDoc = { title: null, sections: [] };
  let section: MinutesSection | null = null;
  const text = markdown.replace(/\r/g, "").replace(FENCE, "");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      const heading = h1[1].replace(/[（(]\*{0,2}仅在[^）)]*[）)]/g, "").trim();
      const title = heading.match(/^会议纪要[：:]\s*(.+)$/);
      if (title && !doc.title) { doc.title = title[1].trim(); section = null; continue; }
      section = { heading, kind: KIND.find(([pattern]) => pattern.test(heading))?.[1] ?? "other", blocks: [] };
      doc.sections.push(section); continue;
    }
    if (!section) { section = { heading: "", kind: "other", blocks: [] }; doc.sections.push(section); }
    const h = line.match(/^(#{2,6})\s+(.+)$/);
    if (h) { section.blocks.push({ type: h[1].length === 2 ? "h2" : "h3", text: h[2].trim() }); continue; }
    const li = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (li) { if (!GUIDANCE.test(li[2])) section.blocks.push({ type: "li", text: li[2].trim(), depth: Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2)) }); continue; }
    const ol = line.match(/^\s*(\d+)[.、)）]\s*(.+)$/);
    if (ol) { section.blocks.push({ type: "ol", n: ol[1], text: ol[2].trim() }); continue; }
    section.blocks.push({ type: "p", text: line.trim() });
  }
  doc.sections = doc.sections.filter(entry => entry.blocks.length || entry.kind !== "other");
  return doc;
}

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ESCAPE[char]);
/** Inline marks the prompt asks for: bold, 【object/topic】 tags, @people. Applied after escaping. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/【([^【】]{1,40})】/g, "<span class=\"m-tag\">$1</span>")
    .replace(/(^|[\s；;，,])@([^\s@；;，,（(]{1,20})/g, "$1<span class=\"m-at\">@$2</span>");
}
/** "要点：内容" → bold key; keeps text without a colon as is. */
function keyed(text: string): string {
  const match = text.match(/^(?:\*\*)?([^：:*]{1,16})(?:\*\*)?[：:](.+)$/);
  return match ? "<b class=\"m-key\">" + escapeHtml(match[1]) + "</b>" + inline(match[2].trim()) : inline(text);
}
export type Todo = { tag: string | null; task: string; people: string[]; teams: string | null; due: string | null };
export function parseTodo(text: string): Todo {
  let rest = text.trim();
  const tag = rest.match(/^【([^【】]+)】/); if (tag) rest = rest.slice(tag[0].length).trim();
  const due = rest.match(/[（(]([^（）()]{1,40})[）)]\s*$/); if (due) rest = rest.slice(0, due.index).trim();
  const teams = rest.match(/[；;]?\s*协作方[：:]\s*(.+)$/); if (teams) rest = rest.slice(0, teams.index).trim();
  const people: string[] = [];
  rest = rest.replace(/(^|\s)@([^\s@；;，,（(]{1,20})/g, (_all: string, _space: string, name: string) => { people.push(name); return " "; }).replace(/[；;\s]+$/, "").trim();
  return { tag: tag?.[1] ?? null, task: rest, people, teams: teams?.[1].trim().replace(/[。.；;]+$/, "") ?? null, due: due?.[1] ?? null };
}
export type Decision = { tag: string | null; title: string | null; body: string };
export function parseDecision(text: string): Decision {
  let rest = text.trim();
  const tag = rest.match(/^【([^【】]+)】/); if (tag) rest = rest.slice(tag[0].length).trim();
  const split = rest.match(/^(?:\*\*)?([^：:]{1,24}?)(?:\*\*)?[：:](.+)$/);
  return { tag: tag?.[1] ?? null, title: split ? split[1] : null, body: split ? split[2].trim() : rest };
}
type Li = Extract<MinutesBlock, { type: "li" }>;
function blocksHtml(blocks: MinutesBlock[], render: (block: Li) => string): string {
  let html = "", list: "ul" | "ol" | null = null;
  const close = () => { if (list) { html += "</" + list + ">"; list = null; } };
  for (const block of blocks) {
    if (block.type === "li") { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += "<li class=\"m-d" + block.depth + "\">" + render(block) + "</li>"; continue; }
    if (block.type === "ol") { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += "<li>" + inline(block.text) + "</li>"; continue; }
    close();
    html += block.type === "p" ? "<p>" + inline(block.text) + "</p>" : "<" + block.type + ">" + inline(block.text) + "</" + block.type + ">";
  }
  close();
  return html;
}
const NUMBERED = /^(?:[一二三四五六七八九十]+|\d+)[.、．]\s*/;
const two = (n: number) => (n < 10 ? "0" : "") + n;
const OVERVIEW_KEY = /^(?:\*\*)?([^：:*]{1,8})(?:\*\*)?[：:]\s*(.*)$/;
/** Theme as the lead line, goals as a numbered list; anything else in the overview stays as written. */
function overviewHtml(section: MinutesSection): string {
  let dek = "", inGoals = false; const goals: string[] = []; const rest: MinutesBlock[] = [];
  for (const block of section.blocks) {
    const key = block.type === "li" && block.depth === 0 ? block.text.match(OVERVIEW_KEY) : null;
    if (key && /主题/.test(key[1]) && !dek && key[2]) { dek = key[2].trim(); inGoals = false; continue; }
    if (key && /目标/.test(key[1])) { inGoals = true; if (key[2]) goals.push(key[2].trim()); continue; }
    if (inGoals && (block.type === "ol" || (block.type === "li" && block.depth > 0))) { goals.push(block.text); continue; }
    if (inGoals && block.type === "p" && NUMBERED.test(block.text)) { goals.push(block.text.replace(NUMBERED, "")); continue; }
    inGoals = false; rest.push(block);
  }
  return "<div class=\"m-overview\">"
    + (dek ? "<p class=\"m-label\">主题</p><p class=\"m-dek\">" + inline(dek) + "</p>" : "")
    + (goals.length ? "<p class=\"m-label\">核心目标</p><ol class=\"m-goals\">" + goals.map((goal, index) => "<li><span class=\"m-n\">" + two(index + 1) + "</span><span>" + inline(goal) + "</span></li>").join("") + "</ol>" : "")
    + (rest.length ? blocksHtml(rest, block => keyed(block.text)) : "") + "</div>";
}
/** Each top-level direction becomes a chapter: its own number, then sub-topics with their points. */
function directionsHtml(section: MinutesSection): string {
  const chapters: { title: string | null; blocks: MinutesBlock[] }[] = [];
  for (const block of section.blocks) {
    if (block.type === "h2") chapters.push({ title: block.text, blocks: [] });
    else { if (!chapters.length) chapters.push({ title: null, blocks: [] }); chapters[chapters.length - 1].blocks.push(block); }
  }
  let number = 0;
  return "<div class=\"m-directions\">" + chapters.map(chapter => {
    let sub = 0; let body = ""; let points: Li[] = [];
    const flush = () => { if (points.length) body += "<ul class=\"m-points\">" + points.map(point => "<li class=\"m-d" + point.depth + "\">" + keyed(point.text) + "</li>").join("") + "</ul>"; points = []; };
    for (const block of chapter.blocks) {
      if (block.type === "li") { points.push(block); continue; }
      flush();
      if (block.type === "h3") body += "<h4 class=\"m-sub\"><span class=\"m-sub-n\">" + (++sub) + "</span>" + inline(block.text.replace(NUMBERED, "").replace(/^【(.+)】$/, "$1")) + "</h4>";
      else body += blocksHtml([block], point => keyed(point.text));
    }
    flush();
    return "<article class=\"m-card\">" + (chapter.title ? "<header class=\"m-chapter\"><span class=\"m-num\">" + two(++number) + "</span><h3 class=\"m-card-title\">" + inline(chapter.title.replace(NUMBERED, "")) + "</h3></header>" : "") + body + "</article>";
  }).join("") + "</div>";
}
function decisionsHtml(section: MinutesSection): string {
  const items = section.blocks.filter((block): block is Li => block.type === "li").map(block => parseDecision(block.text));
  const other = section.blocks.filter(block => block.type !== "li");
  return "<div class=\"m-decisions\">" + items.map(item => "<div class=\"m-decision\">" + (item.tag || item.title ? "<div class=\"m-decision-head\">" + (item.tag ? "<span class=\"m-tag\">" + escapeHtml(item.tag) + "</span>" : "") + (item.title ? "<b>" + inline(item.title) + "</b>" : "") + "</div>" : "") + "<p>" + inline(item.body) + "</p></div>").join("") + "</div>" + (other.length ? blocksHtml(other, block => keyed(block.text)) : "");
}
function todosHtml(section: MinutesSection): string {
  const items = section.blocks.filter((block): block is Li => block.type === "li").map(block => parseTodo(block.text));
  const other = section.blocks.filter(block => block.type !== "li");
  return "<ul class=\"m-todos\">" + items.map(item => "<li><span class=\"m-check\" aria-hidden=\"true\"></span><div class=\"m-todo-main\"><p>" + (item.tag ? "<span class=\"m-tag\">" + escapeHtml(item.tag) + "</span>" : "") + inline(item.task) + "</p>"
    + (item.people.length || item.teams ? "<div class=\"m-meta\">" + item.people.map(name => "<span class=\"m-at\">@" + escapeHtml(name) + "</span>").join("") + (item.teams ? "<span class=\"m-team\">" + escapeHtml(item.teams) + "</span>" : "") + "</div>" : "") + "</div>"
    + (item.due ? "<span class=\"m-due\">" + escapeHtml(item.due) + "</span>" : "") + "</li>").join("") + "</ul>" + (other.length ? blocksHtml(other, block => keyed(block.text)) : "");
}
/** What the minutes contain, counted from the parsed document: shown under the title so the size of the meeting reads at a glance. */
function statsHtml(doc: MinutesDoc): string {
  const of = (kind: MinutesSectionKind, type: MinutesBlock["type"]) => doc.sections.filter(section => section.kind === kind).reduce((sum, section) => sum + section.blocks.filter(block => block.type === type && (type !== "li" || (block as Li).depth === 0)).length, 0);
  const stats = [[of("directions", "h2"), "个方向"], [of("directions", "h3"), "个主题"], [of("decisions", "li"), "项决策"], [of("todos", "li"), "项待办"]].filter(([count]) => count) as [number, string][];
  return stats.length ? "<p class=\"m-stats\">" + stats.map(([count, label]) => "<span><b>" + count + "</b>" + label + "</span>").join("") + "</p>" : "";
}
const HEADING_SHORT: Record<MinutesSectionKind, string | null> = { overview: "概览", directions: "核心方向", decisions: "关键决策", todos: "待办事项", other: null };
/**
 * Body HTML for the plugin page and for the exported file; class names are scoped under .xj-mtg-minutes.
 * meta: a plain line set by the plugin (date, length of the meeting); escaped like everything else.
 */
export function renderMinutesHtml(doc: MinutesDoc, meta?: string): string {
  let html = "<header class=\"m-mast\"><p class=\"m-kicker\"><span class=\"m-seal\" aria-hidden=\"true\"></span>会议纪要" + (meta ? "<span class=\"m-meta-line\">" + escapeHtml(meta) + "</span>" : "") + "</p>"
    + (doc.title ? "<h1 class=\"m-title\">" + inline(doc.title) + "</h1>" : "") + statsHtml(doc) + "</header>";
  for (const section of doc.sections) {
    const body = section.kind === "overview" ? overviewHtml(section) : section.kind === "directions" ? directionsHtml(section) : section.kind === "decisions" ? decisionsHtml(section) : section.kind === "todos" ? todosHtml(section) : blocksHtml(section.blocks, block => keyed(block.text));
    html += "<section class=\"m-section m-sec-" + section.kind + "\">" + (section.heading ? "<h2 class=\"m-heading\"><span>" + inline(HEADING_SHORT[section.kind] ?? section.heading) + "</span></h2>" : "") + body + "</section>";
  }
  return html;
}

/**
 * Shared by the plugin page (index.css carries the same rules under the plugin root) and the exported file.
 * Direction: an editorial meeting brief on warm paper. Serif display type for the title, theme and chapter numbers,
 * a quiet sans for reading, ink rules instead of boxes, and one seal-red accent kept for numbers and decisions.
 * System fonts only, so it renders the same offline inside the host.
 */
export const MINUTES_CSS = ".xj-mtg-minutes{--ink:#17161a;--ink-2:#3a3732;--muted:#8a857b;--line:rgba(23,22,26,.1);--hair:rgba(23,22,26,.06);--paper:#f6f4ef;--seal:#b8402a;--seal-soft:#f7ebe6;--ok:#2f6b4f;--ok-soft:#ecf4ef;"
  + "--serif:\"Songti SC\",\"STSong\",\"Source Han Serif SC\",\"Noto Serif CJK SC\",\"Noto Serif SC\",\"SimSun\",serif;--figure:\"Iowan Old Style\",\"Palatino Linotype\",Palatino,Georgia,serif;"
  + "color:var(--ink-2);font:14.5px/1.8 -apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;container-type:inline-size;overflow-wrap:anywhere;max-width:820px;margin:0 auto;padding:4px 0 8px}"
  + ".xj-mtg-minutes ::selection{background:var(--seal-soft);color:var(--ink)}"
  + ".xj-mtg-minutes .m-mast,.xj-mtg-minutes .m-section{animation:m-rise .55s cubic-bezier(.2,.7,.2,1) both}"
  + ".xj-mtg-minutes .m-section:nth-of-type(1){animation-delay:.06s}.xj-mtg-minutes .m-section:nth-of-type(2){animation-delay:.12s}.xj-mtg-minutes .m-section:nth-of-type(3){animation-delay:.18s}.xj-mtg-minutes .m-section:nth-of-type(n+4){animation-delay:.24s}"
  + "@keyframes m-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}"
  + "@media (prefers-reduced-motion:reduce){.xj-mtg-minutes .m-mast,.xj-mtg-minutes .m-section{animation:none}}"
  + ".xj-mtg-minutes .m-mast{padding:6px 0 22px;margin:0 0 26px;border-bottom:2px solid var(--ink)}"
  + ".xj-mtg-minutes .m-kicker{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin:0 0 12px;color:var(--seal);font-size:12px;font-weight:600;letter-spacing:.18em}"
  + ".xj-mtg-minutes .m-seal{width:7px;height:7px;border-radius:2px;background:var(--seal);transform:rotate(45deg)}"
  + ".xj-mtg-minutes .m-meta-line{color:var(--muted);font-weight:400;letter-spacing:.02em}.xj-mtg-minutes .m-meta-line::before{content:\"/\";margin-right:10px;color:var(--line)}"
  + ".xj-mtg-minutes .m-title{margin:0;color:var(--ink);font:700 30px/1.3 var(--serif);letter-spacing:.01em}"
  + ".xj-mtg-minutes .m-stats{display:flex;flex-wrap:wrap;gap:4px 18px;margin:14px 0 0;color:var(--muted);font-size:12.5px}"
  + ".xj-mtg-minutes .m-stats b{margin-right:4px;color:var(--ink);font:600 17px/1 var(--figure);font-variant-numeric:lining-nums tabular-nums}"
  + ".xj-mtg-minutes .m-section{margin:0 0 34px}"
  + ".xj-mtg-minutes .m-heading{display:flex;align-items:center;gap:12px;margin:0 0 16px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.24em}"
  + ".xj-mtg-minutes .m-heading::after{content:\"\";flex:1;height:1px;background:var(--line)}"
  + ".xj-mtg-minutes ul,.xj-mtg-minutes ol{margin:4px 0;padding-left:20px}.xj-mtg-minutes li{margin:3px 0}.xj-mtg-minutes li.m-d1{margin-left:16px}.xj-mtg-minutes li.m-d2{margin-left:32px}"
  + ".xj-mtg-minutes p{margin:4px 0}"
  + ".xj-mtg-minutes strong{color:var(--ink);font-weight:650;background:linear-gradient(transparent 62%,var(--seal-soft) 62%)}"
  + ".xj-mtg-minutes .m-key{color:var(--ink);font-weight:650}.xj-mtg-minutes .m-key::after{content:\"\";display:inline-block;width:1px;height:.85em;margin:0 9px 0 10px;background:var(--line);vertical-align:-1px}"
  + ".xj-mtg-minutes .m-tag{display:inline-block;margin-right:7px;padding:0 7px;border:1px solid var(--line);border-radius:4px;color:var(--ink-2);font-size:11.5px;font-weight:550;line-height:20px;vertical-align:1px;white-space:nowrap}"
  + ".xj-mtg-minutes .m-at{display:inline-block;margin-right:4px;padding:0 7px;border-radius:999px;background:var(--ink);color:#fff;font-size:11.5px;line-height:20px}"
  + ".xj-mtg-minutes .m-label{margin:0 0 6px;color:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.16em}"
  + ".xj-mtg-minutes .m-dek{margin:0 0 20px;color:var(--ink);font:600 20px/1.55 var(--serif)}"
  + ".xj-mtg-minutes .m-goals{list-style:none;margin:0;padding:0;counter-reset:none}"
  + ".xj-mtg-minutes .m-goals>li{display:flex;gap:14px;margin:0;padding:9px 0;border-top:1px solid var(--hair)}.xj-mtg-minutes .m-goals>li:first-child{border-top:0;padding-top:2px}"
  + ".xj-mtg-minutes .m-n{flex:none;width:22px;color:var(--seal);font:600 15px/1.75 var(--figure);font-variant-numeric:lining-nums tabular-nums}"
  + ".xj-mtg-minutes .m-directions{display:flex;flex-direction:column;gap:0}"
  + ".xj-mtg-minutes .m-card{display:block;margin:0;padding:22px 0 20px;border-top:1px solid var(--line)}.xj-mtg-minutes .m-card:first-child{border-top:0;padding-top:4px}"
  + ".xj-mtg-minutes .m-chapter{display:flex;align-items:baseline;gap:14px;margin:0 0 12px}"
  + ".xj-mtg-minutes .m-num{flex:none;color:var(--seal);font:400 30px/1 var(--figure);font-variant-numeric:lining-nums tabular-nums;letter-spacing:-.02em}"
  + ".xj-mtg-minutes .m-card-title{margin:0;color:var(--ink);font:700 19px/1.45 var(--serif)}"
  + ".xj-mtg-minutes .m-sub{display:flex;align-items:baseline;gap:8px;margin:16px 0 6px;color:var(--ink);font-size:14.5px;font-weight:650}"
  + ".xj-mtg-minutes .m-sub-n{flex:none;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:5px;background:var(--paper);color:var(--muted);font:600 11px/18px var(--figure);text-align:center}"
  + ".xj-mtg-minutes .m-points{list-style:none;margin:0;padding:0 0 0 26px}"
  + ".xj-mtg-minutes .m-points>li{position:relative;margin:0;padding:4px 0}"
  + ".xj-mtg-minutes .m-points>li::before{content:\"\";position:absolute;left:-16px;top:calc(.9em + 3px);width:7px;height:2px;border-radius:1px;background:var(--seal);opacity:.75}"
  + ".xj-mtg-minutes .m-decisions{display:flex;flex-direction:column;gap:10px}"
  + ".xj-mtg-minutes .m-decision{position:relative;padding:14px 18px 14px 20px;border-radius:2px 10px 10px 2px;background:var(--seal-soft)}"
  + ".xj-mtg-minutes .m-decision::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--seal)}"
  + ".xj-mtg-minutes .m-decision-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:2px}.xj-mtg-minutes .m-decision-head b{color:var(--ink);font:700 15.5px/1.5 var(--serif)}"
  + ".xj-mtg-minutes .m-decision .m-tag{border-color:rgba(184,64,42,.25);color:var(--seal)}.xj-mtg-minutes .m-decision p{margin:0;color:var(--ink-2)}"
  + ".xj-mtg-minutes .m-todos{list-style:none;margin:0;padding:0}"
  + ".xj-mtg-minutes .m-todos>li{display:flex;align-items:flex-start;gap:12px;margin:0;padding:12px 2px;border-top:1px solid var(--hair)}.xj-mtg-minutes .m-todos>li:first-child{border-top:0;padding-top:2px}"
  + ".xj-mtg-minutes .m-check{flex:none;width:14px;height:14px;margin-top:6px;border:1.5px solid var(--ink);border-radius:3px;opacity:.55}"
  + ".xj-mtg-minutes .m-todo-main{flex:1;min-width:0}.xj-mtg-minutes .m-todo-main p{margin:0;color:var(--ink)}"
  + ".xj-mtg-minutes .m-meta{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}"
  + ".xj-mtg-minutes .m-team{padding:0 8px;border-radius:999px;background:var(--paper);color:var(--muted);font-size:11.5px;line-height:20px}"
  + ".xj-mtg-minutes .m-due{flex:none;margin-top:3px;padding:0 9px;border:1px solid var(--line);border-radius:999px;color:var(--ink-2);font-size:11.5px;line-height:20px;white-space:nowrap;font-variant-numeric:tabular-nums}"
  + "@container (max-width:520px){.xj-mtg-minutes .m-title{font-size:24px}.xj-mtg-minutes .m-dek{font-size:17px}.xj-mtg-minutes .m-num{font-size:24px}.xj-mtg-minutes .m-card-title{font-size:17px}.xj-mtg-minutes .m-points{padding-left:18px}.xj-mtg-minutes .m-points>li::before{left:-13px}.xj-mtg-minutes .m-todos>li{flex-wrap:wrap}.xj-mtg-minutes .m-due{margin-left:26px}}"
  + "@media print{.xj-mtg-minutes .m-mast,.xj-mtg-minutes .m-section{animation:none}.xj-mtg-minutes .m-card,.xj-mtg-minutes .m-decision,.xj-mtg-minutes .m-todos>li{break-inside:avoid}}";
/** Standalone, responsive HTML file of the minutes: the same brief on a sheet of paper. */
export function minutesDocument(markdown: string, heading: string, meta?: string): string {
  const doc = parseMinutes(markdown);
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + escapeHtml(doc.title ?? heading) + "</title><style>"
    + "body{margin:0;background:#ebe8e1 radial-gradient(1200px 500px at 50% -10%,#f6f4ef,transparent)}main{box-sizing:border-box;max-width:920px;margin:clamp(0px,4vw,48px) auto;padding:clamp(20px,5vw,56px) clamp(18px,5vw,50px);background:#fffdf9;border-radius:6px;box-shadow:0 1px 2px rgba(23,22,26,.06),0 18px 48px -24px rgba(23,22,26,.25)}"
    + "@media print{body{background:#fff}main{margin:0;box-shadow:none;max-width:none}}"
    + MINUTES_CSS + "</style></head><body><main><div class=\"xj-mtg-minutes\">" + renderMinutesHtml(doc, meta) + "</div></main></body></html>";
}
/** "11月19日 15:01 · 58 分钟": the line above the title, from the meeting record. */
export function minutesMeta(startedAt: number, endedAt: number | null): string {
  const when = new Date(startedAt).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return when + (endedAt && endedAt > startedAt ? " · " + Math.max(1, Math.round((endedAt - startedAt) / 60000)) + " 分钟" : "");
}

