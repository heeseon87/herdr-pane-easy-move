#!/usr/bin/env node
// Pane Easy Move: move the current pane by pointing at a drawn map.
// The first screen draws every tab as a small map, one row per workspace, and
// scrolls when they do not fit. Enter zooms into one tab. In either view, pick a
// pane and a side (or the center to swap); a ghost shows where the moving pane
// will land, and the bottom line says it in words.
"use strict";

const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// --exec: run the chosen herdr commands after the popup has closed.
if (process.argv[2] === "--exec") {
  const cmds = JSON.parse(process.argv[3]);
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  setTimeout(() => {
    const log = [];
    for (const args of cmds) {
      const r = spawnSync(bin, args, { encoding: "utf8" });
      log.push({ args, status: r.status, err: (r.stderr || "").trim() });
      if (r.status !== 0) break;
    }
    try {
      const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? "/tmp/herdr-pane-easy-move";
      fs.writeFileSync(path.join(dir, "last-exec.json"), JSON.stringify(log, null, 1));
    } catch {}
    process.exit(0);
  }, 200);
  return;
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? "/tmp/herdr-pane-easy-move";

// ---------- herdr data ----------

function cliJson(args) {
  const r = spawnSync(herdr, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`herdr ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout).result;
}

function resolveTarget(panes, override) {
  if (override) return override;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, "target.json"), "utf8"));
    if (s.target && Date.now() - s.at < 15000) return s.target;
  } catch {}
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    const id = ctx.pane_id ?? ctx.focused_pane_id ?? ctx.pane?.pane_id ?? ctx.focused_pane?.pane_id;
    if (id) return id;
  } catch {}
  return panes.find((p) => p.focused)?.pane_id ?? null;
}

function gather(override) {
  const panes = cliJson(["pane", "list"]).panes;
  const workspaces = cliJson(["workspace", "list"]).workspaces.sort((a, b) => a.number - b.number);
  for (const ws of workspaces) {
    ws.tabs = cliJson(["tab", "list", "--workspace", ws.workspace_id]).tabs.sort((a, b) => a.number - b.number);
  }
  const target = resolveTarget(panes, override);
  const tp = panes.find((p) => p.pane_id === target) || null;
  return { panes, workspaces, target, tp, layouts: new Map() };
}

function layoutOf(st, tab) {
  if (!st.layouts.has(tab.tab_id)) {
    const first = st.panes.find((p) => p.tab_id === tab.tab_id);
    let lay = null;
    try { if (first) lay = cliJson(["pane", "layout", "--pane", first.pane_id]).layout; } catch {}
    st.layouts.set(tab.tab_id, lay);
  }
  return st.layouts.get(tab.tab_id);
}

function paneName(p) {
  return p.label || p.terminal_title_stripped || p.agent || path.basename(p.cwd || "") || p.pane_id;
}
const paneById = (st, id) => st.panes.find((p) => p.pane_id === id);

// ---------- display width (Korean is 2 cells) ----------

function cw(cp) {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) return 2;
  return 1;
}
const strW = (s) => [...s].reduce((n, c) => n + cw(c.codePointAt(0)), 0);
function fit(s, w) {
  if (w <= 0) return "";
  if (strW(s) <= w) return s;
  let out = "", n = 0;
  for (const c of s) {
    const k = cw(c.codePointAt(0));
    if (n + k > w - 1) break;
    out += c; n += k;
  }
  return out + "…";
}

// ---------- cell buffer ----------

const ESC = "\x1b[";
const S = {
  n: "",
  dim: ESC + "2m",
  bold: ESC + "1m",
  inv: ESC + "7m",
  orange: ESC + "1;38;2;194;90;44m",
  blue: ESC + "1;38;2;44;85;196m",
  ghost: ESC + "1;38;2;255;255;255;48;2;44;85;196m",
  dragGhost: ESC + "1;38;2;255;255;255;48;2;47;107;42m",
  dragSrc: ESC + "38;2;47;107;42;48;2;222;232;214m",
  green: ESC + "38;2;47;107;42m",
  chip: ESC + "1;38;2;255;252;245;48;2;42;37;32m",
  ghostSoft: ESC + "38;2;44;85;196;48;2;214;224;248m",
  moving: ESC + "38;2;194;90;44;48;2;246;226;214m",
  pick: ESC + "38;2;44;85;196;48;2;214;224;248m",
  // workspace bands: a background laid under whatever is drawn on top
  bandTarget: ESC + "48;2;228;234;246m", // the workspace the picked tab is in
};

let W = 100, H = 30, buf = [];
function clear() {
  W = process.stdout.columns || 100;
  H = process.stdout.rows || 30;
  buf = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: " ", st: "", bg: "" })));
}
function put(x, y, s, st = "", maxX = W) {
  if (y < 0 || y >= H) return x;
  for (const c of s) {
    const k = cw(c.codePointAt(0));
    if (k === 0) continue;
    if (x + k > maxX || x + k > W) break;
    if (x >= 0) {
      buf[y][x] = { ch: c, st, bg: buf[y][x].bg };
      if (k === 2) buf[y][x + 1] = { ch: "", st, bg: buf[y][x + 1].bg };
    }
    x += k;
  }
  return x;
}
function fill(x0, y0, w, h, st) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
    if (y >= 0 && y < H && x >= 0 && x < W) buf[y][x] = { ch: " ", st, bg: buf[y][x].bg };
}
// Lay a background under a region; text drawn there later keeps it unless its own style sets one.
function band(x0, y0, w, h, bg) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
    if (y >= 0 && y < H && x >= 0 && x < W) buf[y][x].bg = bg;
}
function box(x, y, w, h, st) {
  if (w < 2 || h < 2) return;
  put(x, y, "┌" + "─".repeat(w - 2) + "┐", st);
  for (let i = 1; i < h - 1; i++) { put(x, y + i, "│", st); put(x + w - 1, y + i, "│", st); }
  put(x, y + h - 1, "└" + "─".repeat(w - 2) + "┘", st);
}
function flush() {
  let o = ESC + "H";
  for (let y = 0; y < H; y++) {
    let cur = null;
    for (const c of buf[y]) {
      if (c.ch === "") continue;
      const k = (c.bg || "") + c.st;
      if (k !== cur) { o += ESC + "0m" + k; cur = k; }
      o += c.ch;
    }
    o += ESC + "0m" + (y < H - 1 ? "\r\n" : "");
  }
  process.stdout.write(o);
}

// ---------- model ----------

// Overview items in order: each workspace's tabs and its "new tab", then "new workspace".
function buildRows(st) {
  const rows = [];
  for (const ws of st.workspaces) {
    for (const tab of ws.tabs) rows.push({ kind: "tab", ws, tab });
    rows.push({ kind: "newtab", ws });
  }
  rows.push({ kind: "newws" });
  return rows;
}

const ui = {
  rows: [], sel: 0,
  focus: "overview",    // "overview" | "map"
  slot: null,           // { pane: paneId, side: "left"|"right"|"up"|"down"|"swap" }
  armed: null,          // slot key that a click will execute
  hits: [],             // pane rects on screen for mouse (overview hits also carry the row index i)
  tiles: [],            // overview titles and "+ new" tiles on screen: { i, r }
  ov: null,             // overview geometry from the last render
  ovTop: 0,             // first overview line on screen
  follow: true,
  undo: [],             // where dragged panes came from, newest last: u puts the last one back         // scroll the overview to the selection on the next render
  msg: "",
};

// ---------- messages (English default; set language = "ko" in config.toml) ----------

function loadLang() {
  if (process.env.HERDR_PANE_EASY_MOVE_LANG) return process.env.HERDR_PANE_EASY_MOVE_LANG;
  try {
    const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    const m = dir && fs.readFileSync(path.join(dir, "config.toml"), "utf8").match(/^\s*language\s*=\s*"(\w+)"/m);
    if (m) return m[1];
  } catch {}
  return "en";
}
const MSG = {
  en: {
    side: { left: "left of", right: "right of", up: "above", down: "below" },
    tab: (n) => `tab ${n}`,
    tabWord: "tab",
    toNewTab: (me, ws) => `Move ${me} to a new tab in workspace '${ws}'.`,
    toNewWs: (me) => `Move ${me} to a new workspace.`,
    swap: (me, where, other) => `Swap ${me} with ${other} in ${where}.`,
    place: (me, where, other, side) => `Put ${me} ${side} ${other} in ${where}.`,
    newTab: "+ new tab",
    newWs: "+ new workspace",
    noLayout: "Could not read this tab's layout.",
    movingHere: "<- the pane you are moving (leaves here)",
    swapBox: (name) => `⇄ swap with '${name}'`,
    here: "here",
    onlySelf: "This tab only holds the pane you are moving. Pick another tab.",
    title: "Move pane",
    now: "Now at: ",
    zoomHint: (where) => `Enter zooms into ${where}.`,
    moreAbove: "▲ more above",
    moreBelow: "▼ more below",
    keysOverview: "←↑→↓ pick tab · Enter zoom in · wheel scrolls · drag any pane onto another pane's edge or a + new tile · u undo · Esc close",
    keysMap: "←↑→↓ side · Tab/number target pane · Space swap · Enter move · Esc back",
    pickFirst: "Pick a spot first.",
    swapSameTab: "Swap works only inside one tab (herdr limit).",
    dragged: (name) => `Moved '${name}'. Press u to undo, drag another pane, or press Esc to close.`,
    undone: (name) => `Put '${name}' back.`,
    nothingToUndo: "Nothing to undo.",
    undoLost: (name) => `Cannot put '${name}' back: its pane or its neighbor is gone.`,
    dragHint: (name) => `Drag '${name}' onto another pane's edge to move it there.`,
    dragNowhere: (name) => `Dragging '${name}'. Point at another pane's edge or a "+ new" tile.`,
    dragLeaves: "↗ dragging (leaves here)",
    dragFailed: (err) => `Move failed: ${err}`,
    moving: (name) => `Moving '${name}'…`,
    noTarget: "could not find the pane to move",
  },
  ko: {
    side: { left: "왼쪽에", right: "오른쪽에", up: "위에", down: "아래에" },
    tab: (n) => `탭 ${n}`,
    tabWord: "탭",
    toNewTab: (me, ws) => `${me} pane을 '${ws}' 워크스페이스의 새 탭으로 옮겨.`,
    toNewWs: (me) => `${me} pane을 새 워크스페이스로 옮겨.`,
    swap: (me, where, other) => `${me} pane과 ${where} 탭의 ${other} pane의 자리를 서로 바꿔.`,
    place: (me, where, other, side) => `${me} pane을 ${where} 탭의 ${other} pane ${side} 붙여.`,
    newTab: "+ 새 탭",
    newWs: "+ 새 워크스페이스",
    noLayout: "이 탭의 배치를 읽지 못했어.",
    movingHere: "← 지금 옮기려는 pane (여기서 빠져)",
    swapBox: (name) => `⇄ '${name}'와 자리 바꿈`,
    here: "여기로",
    onlySelf: "이 탭에는 옮길 pane 자신만 있어. 다른 탭을 골라.",
    title: "pane 옮기기",
    now: "지금 위치: ",
    zoomHint: (where) => `Enter를 누르면 ${where} 탭을 크게 보여줘.`,
    moreAbove: "▲ 위에 더 있어",
    moreBelow: "▼ 아래에 더 있어",
    keysOverview: "←↑→↓ 탭 고르기 · Enter 크게 보기 · 휠로 스크롤 · 아무 pane이나 끌어서 다른 pane 가장자리나 '+ 새' 칸에 놓기 · u 되돌리기 · Esc 닫기",
    keysMap: "←↑→↓ 붙일 쪽 · Tab/숫자 기준 pane · Space 자리 바꾸기 · Enter 실행 · Esc 전체 보기로",
    pickFirst: "먼저 붙일 자리를 골라.",
    swapSameTab: "자리 바꾸기는 같은 탭 안에서만 돼 (herdr 제약).",
    dragged: (name) => `'${name}' pane을 옮겼어. u로 되돌리거나, 다른 pane을 계속 끌거나, Esc로 닫아.`,
    undone: (name) => `'${name}' pane을 원래 자리로 돌려놨어.`,
    nothingToUndo: "되돌릴 게 없어.",
    undoLost: (name) => `'${name}' pane을 되돌릴 수 없어: 그 pane이나 옆 pane이 없어졌어.`,
    dragHint: (name) => `'${name}' pane을 끌어서 다른 pane 가장자리에 놓으면 거기로 옮겨.`,
    dragNowhere: (name) => `'${name}' pane을 끄는 중이야. 다른 pane 가장자리나 "+ 새" 칸을 가리켜.`,
    dragLeaves: "↗ 끄는 중 (여기서 빠져)",
    dragFailed: (err) => `옮기지 못했어: ${err}`,
    moving: (name) => `'${name}' pane을 옮기는 중…`,
    noTarget: "옮길 pane을 찾지 못했어",
  },
};
const L = MSG[loadLang()] || MSG.en;
const slotKey = (s) => s && `${s.pane}/${s.side}`;
const selRow = () => ui.rows[ui.sel];

function dropPanes(st, row) {
  if (!row || row.kind !== "tab") return [];
  const lay = layoutOf(st, row.tab);
  if (!lay) return [];
  return lay.panes.filter((p) => p.pane_id !== st.target);
}

function defaultSlot(st, row) {
  const cands = dropPanes(st, row);
  if (!cands.length) return null;
  const lay = layoutOf(st, row.tab);
  const pick = cands.find((p) => p.pane_id === lay.focused_pane_id) || cands[0];
  return { pane: pick.pane_id, side: "right" };
}

// ---------- describing and executing ----------

function tabTitle(ws, tab) {
  return `${ws.number} ${ws.label} › ${tab.label || L.tab(tab.number)}`;
}

function describe(st) {
  const row = selRow();
  const me = `'${fit(paneName(st.tp), 24)}'`;
  if (!row) return "";
  if (row.kind === "newtab") return L.toNewTab(me, `${row.ws.number} ${row.ws.label}`);
  if (row.kind === "newws") return L.toNewWs(me);
  if (row.kind !== "tab" || !ui.slot) return "";
  const p = paneById(st, ui.slot.pane);
  const where = tabTitle(row.ws, row.tab);
  const n = mapNumber(st, row, ui.slot.pane);
  const other = `${n} '${fit(p ? paneName(p) : ui.slot.pane, 20)}'`;
  if (ui.slot.side === "swap") return L.swap(me, where, other);
  return L.place(me, where, other, L.side[ui.slot.side]);
}

function commands(st) {
  const row = selRow();
  const T = st.target, tp = st.tp;
  if (row.kind === "newtab") return [["pane", "move", T, "--new-tab", "--workspace", row.ws.workspace_id, "--focus"]];
  if (row.kind === "newws") return [["pane", "move", T, "--new-workspace", "--focus"]];
  if (row.kind !== "tab" || !ui.slot) return null;
  return placeCmds(tp, row.tab.tab_id, ui.slot, "--focus");
}

// Commands that put pane `src` on `slot.side` of pane `slot.pane` in tab `tabId`.
function placeCmds(src, tabId, slot, focus) {
  const T = src.pane_id, P = slot.pane, side = slot.side;
  if (side === "swap") return [["pane", "swap", "--source-pane", T, "--target-pane", P]];
  const cmds = [];
  // herdr cannot re-split inside one tab, so bounce the pane out first.
  if (tabId === src.tab_id)
    cmds.push(["pane", "move", T, "--new-tab", "--workspace", src.workspace_id, "--no-focus"]);
  const base = side === "left" || side === "up" ? (side === "left" ? "right" : "down") : side;
  cmds.push(["pane", "move", T, "--tab", tabId, "--split", base, "--target-pane", P, focus]);
  if (side === "left" || side === "up") cmds.push(["pane", "swap", "--source-pane", T, "--target-pane", P]);
  return cmds;
}

// ---------- drawing ----------

function mapNumber(st, row, paneId) {
  const lay = layoutOf(st, row.tab);
  const i = lay ? lay.panes.findIndex((p) => p.pane_id === paneId) : -1;
  return i < 0 ? "" : String(i + 1);
}

function ghostRect(r, side) {
  const hw = Math.max(1, Math.floor(r.w / 2)), hh = Math.max(1, Math.floor(r.h / 2));
  if (side === "left") return { x: r.x, y: r.y, w: hw, h: r.h };
  if (side === "right") return { x: r.x + r.w - hw, y: r.y, w: hw, h: r.h };
  if (side === "up") return { x: r.x, y: r.y, w: r.w, h: hh };
  if (side === "down") return { x: r.x, y: r.y + r.h - hh, w: r.w, h: hh };
  return r;
}

function centerText(r, y, s, st) {
  const t = fit(s, r.w - 2);
  put(r.x + Math.max(1, Math.floor((r.w - strW(t)) / 2)), y, t, st, r.x + r.w - 1);
}

function drawMap(st, x0, y0, w, h) {
  ui.hits = [];
  const row = selRow();
  const lay = layoutOf(st, row.tab);
  if (!lay) { put(x0, y0, L.noLayout, S.dim); return; }
  const A = lay.area;
  const sx = (v) => x0 + Math.round(((v - A.x) * w) / A.width);
  const sy = (v) => y0 + Math.round(((v - A.y) * h) / A.height);
  lay.panes.forEach((lp, i) => {
    const r = { x: sx(lp.rect.x), y: sy(lp.rect.y) };
    r.w = sx(lp.rect.x + lp.rect.width) - r.x;
    r.h = sy(lp.rect.y + lp.rect.height) - r.y;
    const p = paneById(st, lp.pane_id);
    const look = paneLook(st, lp.pane_id, false);
    const ghost = ghostFor(st, lp.pane_id, true);
    ui.hits.push({ pane: lp.pane_id, tab: row.tab.tab_id, r });
    if (look.fill) fill(r.x, r.y, r.w, r.h, look.fill);
    box(r.x, r.y, r.w, r.h, ghost && !dragging() ? S.blue : look.border);
    put(r.x + 2, r.y + 1, fit(`${i + 1}  ${p ? paneName(p) : lp.pane_id}`, r.w - 4), look.note ? look.name : S.bold, r.x + r.w - 1);
    if (r.h > 3) put(r.x + 2, r.y + 2, fit(look.note || path.basename(p?.cwd || ""), r.w - 4), look.note ? look.name : S.dim, r.x + r.w - 1);
    if (ghost) drawGhost(r, ...ghost);
  });
  if (!dropPanes(st, row).length)
    put(x0, y0 + h, L.onlySelf, S.dim);
}

// ---------- overview: every tab as a small map ----------

// Thumbnails keep a readable size (60-88 cells wide, 12 rows tall); more tabs scroll instead of shrinking.
// On a short screen they get shorter so that at least two lines of tabs still show.
const THUMB_MIN_W = 60, THUMB_MAX_W = 88, THUMB_H = 12;

function ovLayout(st, w, h) {
  const gridW = w - 4; // inside a workspace frame: a border and a space on each side
  const cols = Math.max(1, Math.floor((gridW + 2) / (THUMB_MIN_W + 2)));
  const tw = Math.max(16, Math.min(THUMB_MAX_W, Math.floor((gridW + 2) / cols) - 2));
  const th = Math.max(4, Math.min(THUMB_H, Math.floor(h / 2) - 2));
  // One or more lines per workspace, each holding up to `cols` tiles: its tabs, then "+ new tab" at the same size.
  // A workspace's first line carries a name row; the last line ends with a padding row and a blank row.
  const lines = [];
  let idx = 0;
  for (const ws of st.workspaces) {
    let line = null;
    const open = () => { line = { ws, first: !line, last: false, h: th + 1 + (line ? 0 : 1), items: [] }; lines.push(line); };
    for (let n = 0; n <= ws.tabs.length; n++) {
      if (!line || line.items.length === cols) open();
      line.items.push({ i: idx++, x: line.items.length * (tw + 2), w: tw });
    }
    line.last = true;
    line.h += 2; // the bottom border, then a blank row before the next workspace
  }
  lines.push({ ws: null, first: true, last: true, h: th + 1, items: [{ i: idx++, x: 0, w: tw }] });
  return { gridW, tw, th, lines };
}

function ovLineOf(g, i) {
  return Math.max(0, g.lines.findIndex((l) => l.items.some((it) => it.i === i)));
}

// The largest ovTop that still fills the screen, so scrolling stops at the last line.
function ovMaxTop(g, h) {
  let used = 0, t = g.lines.length;
  while (t > 0 && used + g.lines[t - 1].h <= h) used += g.lines[--t].h;
  return t;
}

function drawGhost(r, slot, name, gst = S.ghost) {
  const g = ghostRect(r, slot.side);
  if (slot.side === "swap") {
    fill(g.x + 1, g.y + 1, g.w - 2, g.h - 2, S.ghostSoft);
    box(g.x, g.y, g.w, g.h, S.blue);
    centerText(g, g.y + Math.floor(g.h / 2), L.swapBox(fit(name, 16)), S.ghostSoft + S.bold);
    return;
  }
  fill(g.x, g.y, g.w, g.h, gst);
  box(g.x, g.y, g.w, g.h, gst);
  const arrow = { left: "◀", right: "▶", up: "▲", down: "▼" }[slot.side];
  centerText(g, g.y + Math.floor(g.h / 2) - (g.h > 4 ? 1 : 0), `${arrow} ${L.here}`, gst);
  if (g.h > 4) centerText(g, g.y + Math.floor(g.h / 2), fit(name, 20), gst);
}

// How a pane is painted: the popup's pane orange, a dragged pane green and hollow, the hovered pane blue.
function paneLook(st, id, on) {
  if (isDragSrc(id)) return { fill: S.dragSrc, border: S.green, name: S.green + S.bold, note: L.dragLeaves };
  if (id === st.target) return { fill: S.moving, border: S.orange, name: S.orange + S.bold, note: L.movingHere };
  if (!dragging() && ui.hover === id) return { fill: on ? S.pick : null, border: S.blue, name: S.blue + S.bold };
  if (on) return { fill: S.pick, border: S.pick, name: S.pick + S.bold };
  return { fill: null, border: S.dim, name: S.n };
}

// While a pane is dragged, it is the one drawn as moving, and the ghost follows the drag.
const dragging = () => ui.drag && ui.drag.active;
const isDragSrc = (id) => dragging() && ui.drag.src.pane_id === id;
function ghostFor(st, paneId, own) {
  if (dragging()) return ui.drag.slot && ui.drag.slot.pane === paneId ? [ui.drag.slot, paneName(ui.drag.src), S.dragGhost] : null;
  return own && ui.slot && ui.slot.pane === paneId ? [ui.slot, paneName(st.tp)] : null;
}

function drawThumb(st, i, row, x, y, tw, th, on) {
  const here = row.tab.tab_id === st.tp.tab_id;
  const t = fit(`${on ? "▶ " : ""}${row.tab.label || L.tab(row.tab.number)}${here ? " ●" : ""}`, tw);
  put(x, y, on ? t + " ".repeat(Math.max(0, tw - strW(t))) : t, on ? S.inv : here ? S.orange : S.bold);
  ui.tiles.push({ i, r: { x, y, w: tw, h: 1 } });
  const lay = layoutOf(st, row.tab);
  if (!lay) { put(x, y + 1, fit(L.noLayout, tw), S.dim); return; }
  const A = lay.area, y0 = y + 1;
  const sx = (v) => x + Math.round(((v - A.x) * tw) / A.width);
  const sy = (v) => y0 + Math.round(((v - A.y) * th) / A.height);
  let ghostAt = null;
  lay.panes.forEach((lp, n) => {
    const r = { x: sx(lp.rect.x), y: sy(lp.rect.y) };
    r.w = sx(lp.rect.x + lp.rect.width) - r.x;
    r.h = sy(lp.rect.y + lp.rect.height) - r.y;
    const p = paneById(st, lp.pane_id);
    const look = paneLook(st, lp.pane_id, on);
    const ghost = ghostFor(st, lp.pane_id, on);
    ui.hits.push({ pane: lp.pane_id, tab: row.tab.tab_id, r, i });
    // The picked tab lights up pale blue, so it is clear which one Enter acts on.
    if (look.fill) fill(r.x, r.y, r.w, r.h, look.fill);
    box(r.x, r.y, r.w, r.h, look.border);
    // The name sits on the top border, as herdr draws pane labels, so a 2-row pane still shows it.
    if (r.w >= 5) put(r.x + 1, r.y, fit(`${n + 1} ${p ? paneName(p) : ""}`, r.w - 2), look.name, r.x + r.w - 1);
    if (look.note && r.h > 2 && r.w > 6) put(r.x + 2, r.y + 1, fit(look.note, r.w - 4), look.name, r.x + r.w - 1);
    if (ghost) ghostAt = [r, ghost];
  });
  if (ghostAt) drawGhost(ghostAt[0], ...ghostAt[1]);
}

// "+ new tab" / "+ new workspace". Picked, it opens into a ghost of the pane landing there alone.
// "+ new tab" / "+ new workspace", drawn at the size of a tab. Picked, it fills with a ghost of the pane landing there alone.
function newTile(st, i, label, x, y, w, h, on) {
  const t = fit(`${on ? "▶ " : ""}${label}`, w);
  put(x, y, on ? t + " ".repeat(Math.max(0, w - strW(t))) : t, on ? S.inv : S.dim);
  const r = { x, y: y + 1, w, h };
  const mid = r.y + Math.floor(r.h / 2);
  const dropHere = dragging() && ui.drag.slot && ui.drag.slot.tile === i;
  if (dropHere || (on && !dragging())) {
    const gst = dropHere ? S.dragGhost : S.ghost;
    fill(r.x, r.y, r.w, r.h, gst);
    box(r.x, r.y, r.w, r.h, gst);
    centerText(r, mid - 1, `▶ ${L.here}`, gst);
    centerText(r, mid, fit(paneName(dropHere ? ui.drag.src : st.tp), r.w - 4), gst);
  } else {
    put(r.x, r.y, "┌" + "╌".repeat(r.w - 2) + "┐", S.dim);
    for (let yy = r.y + 1; yy < r.y + r.h - 1; yy++) { put(r.x, yy, "╎", S.dim); put(r.x + r.w - 1, yy, "╎", S.dim); }
    put(r.x, r.y + r.h - 1, "└" + "╌".repeat(r.w - 2) + "┘", S.dim);
    centerText(r, mid - (r.h > 4 ? 1 : 0), "+", S.dim);
  }
  ui.tiles.push({ i, r: { x, y, w, h: h + 1 } });
}

function drawOverview(st, x0, y0, w, h) {
  const g = ovLayout(st, w, h);
  ui.ov = g; ui.hits = []; ui.tiles = [];
  if (ui.follow) {
    const selL = ovLineOf(g, ui.sel);
    if (ui.ovTop > selL) ui.ovTop = selL;
    const used = (t) => g.lines.slice(t, selL + 1).reduce((s, l) => s + l.h, 0);
    while (ui.ovTop < selL && used(ui.ovTop) > h) ui.ovTop++;
    ui.follow = false;
  }
  ui.ovTop = Math.max(0, Math.min(ui.ovTop, ovMaxTop(g, h)));
  let y = y0, l = ui.ovTop;
  for (; l < g.lines.length && y + g.lines[l].h <= y0 + h; l++) {
    const line = g.lines[l];
    let ty = y;
    if (line.ws) {
      // pale blue band behind the workspace that holds the picked tab
      const picked = ui.rows[ui.sel]?.ws === line.ws;
      const here = line.ws.workspace_id === st.tp.workspace_id;
      const fh = line.h - (line.last ? 1 : 0);
      if (picked) band(x0, y, w, fh, S.bandTarget);
      if (line.first) {
        put(x0 + 1, y, fit(`${line.ws.number} ${line.ws.label}`, w - 4), here ? S.orange : picked ? S.blue : S.bold);
        ty = y + 1;
      } else if (l === ui.ovTop) {
        // scrolled into the middle of a workspace: name it on the row above
        put(x0, y0 - 1, fit(`${line.ws.number} ${line.ws.label} …`, w - strW(L.moreAbove) - 4), S.dim);
      }
    }
    for (const it of line.items) {
      const row = ui.rows[it.i], on = it.i === ui.sel;
      if (row.kind === "tab") drawThumb(st, it.i, row, x0 + 2 + it.x, ty, g.tw, g.th, on);
      else newTile(st, it.i, row.kind === "newtab" ? L.newTab : L.newWs, x0 + 2 + it.x, ty, it.w, g.th, on);
    }
    y += line.h;
  }
  if (ui.ovTop > 0) put(x0 + w - strW(L.moreAbove) - 1, y0 - 1, L.moreAbove, S.dim);
  if (l < g.lines.length) put(x0 + w - strW(L.moreBelow) - 1, y0 + h, L.moreBelow, S.dim);
}

function ovMove(st, dir) {
  const g = ui.ov;
  if (!g) return;
  if (dir === "left") ui.sel = Math.max(0, ui.sel - 1);
  else if (dir === "right") ui.sel = Math.min(ui.rows.length - 1, ui.sel + 1);
  else {
    // up/down: the item on the next line whose center is closest to this one's
    const l = ovLineOf(g, ui.sel), nl = l + (dir === "down" ? 1 : -1);
    if (nl < 0 || nl >= g.lines.length) return;
    const center = (line, it) => it.x + it.w / 2;
    const cx = center(g.lines[l], g.lines[l].items.find((it) => it.i === ui.sel));
    const next = g.lines[nl];
    ui.sel = next.items.reduce((a, b) => (Math.abs(center(next, b) - cx) < Math.abs(center(next, a) - cx) ? b : a)).i;
  }
  ui.slot = null; ui.armed = null; ui.follow = true;
}

function dragText(st) {
  const d = ui.drag, me = `'${fit(paneName(d.src), 24)}'`;
  if (!d.slot) return L.dragNowhere(fit(paneName(d.src), 24));
  if (d.slot.tile !== undefined) {
    const r = ui.rows[d.slot.tile];
    return r.kind === "newtab" ? L.toNewTab(me, `${r.ws.number} ${r.ws.label}`) : L.toNewWs(me);
  }
  const p = paneById(st, d.slot.pane);
  const ws = st.workspaces.find((w) => w.workspace_id === p.workspace_id);
  const tab = ws.tabs.find((t) => t.tab_id === p.tab_id);
  const lay = layoutOf(st, tab);
  const n = lay ? lay.panes.findIndex((x) => x.pane_id === p.pane_id) + 1 : "";
  const other = `${n} '${fit(paneName(p), 20)}'`, where = tabTitle(ws, tab);
  if (d.slot.side === "swap") return L.swap(me, where, other);
  return L.place(me, where, other, L.side[d.slot.side]);
}

function render(st) {
  clear();
  const tx = put(1, 0, L.title + "  ", S.bold);
  put(put(tx, 0, L.now, S.dim), 0,
    `${tabTitle(st.workspaces.find((w) => w.workspace_id === st.tp.workspace_id), st.workspaces.flatMap((w) => w.tabs).find((t) => t.tab_id === st.tp.tab_id) || { number: "?" })} · '${paneName(st.tp)}'`, S.orange);
  const row = selRow();
  if (ui.focus === "map") {
    put(1, 2, fit(tabTitle(row.ws, row.tab), W - 2), S.bold);
    drawMap(st, 1, 3, W - 3, H - 8);
  } else drawOverview(st, 1, 3, W - 2, H - 7);
  // bottom: the action in words, then keys
  let d = dragging() ? dragText(st) : describe(st);
  if (!d && ui.hover) d = L.dragHint(paneName(paneById(st, ui.hover) || { pane_id: ui.hover }));
  if (!d && ui.focus === "overview" && row?.kind === "tab") d = L.zoomHint(tabTitle(row.ws, row.tab));
  put(1, H - 3, d ? "→ " + fit(d, W - 4) : "", dragging() ? S.green + S.bold : S.blue);
  put(1, H - 2, fit(ui.focus === "map" ? L.keysMap : L.keysOverview, W - 2), S.dim);
  if (ui.msg) put(1, H - 1, fit(ui.msg, W - 2), S.orange);
  if (dragging()) {
    // a chip with the dragged pane's name rides next to the pointer
    const label = ` ✥ ${fit(paneName(ui.drag.src), 24)} `;
    const cx = Math.min(W - strW(label) - 1, ui.drag.mx + 2), cy = Math.min(H - 1, ui.drag.my + 1);
    put(cx, cy, label, S.chip);
  }
  flush();
}

// ---------- input ----------

function setRowFromSel(st) {
  ui.slot = ui.focus === "map" ? defaultSlot(st, selRow()) : null;
  ui.armed = null;
}

function cyclePane(st, d) {
  const c = dropPanes(st, selRow());
  if (!c.length) return;
  const i = Math.max(0, c.findIndex((p) => p.pane_id === ui.slot?.pane));
  ui.slot = { pane: c[(i + d + c.length) % c.length].pane_id, side: ui.slot?.side === "swap" ? "swap" : ui.slot?.side || "right" };
}

function slotAt(st, x, y, src = st.tp) {
  for (const h of ui.hits) {
    const { r } = h;
    if (h.pane === src.pane_id || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
    const u = (x - r.x + 0.5) / r.w, v = (y - r.y + 0.5) / r.h;
    // herdr swaps only inside one tab, so the center (swap) zone exists only there.
    if (h.tab === src.tab_id && Math.abs(u - 0.5) < 0.2 && Math.abs(v - 0.5) < 0.2) return { pane: h.pane, side: "swap", i: h.i };
    const d = { left: u, right: 1 - u, up: v, down: 1 - v };
    const side = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
    return { pane: h.pane, side, i: h.i };
  }
  return null;
}

let done = false;
function finish(st, run) {
  if (done) return;
  done = true;
  let cmds = null;
  if (run) {
    cmds = commands(st);
    if (!cmds) { done = false; ui.msg = L.pickFirst; return render(st); }
  }
  process.stdout.write(ESC + "?1003l" + ESC + "?1006l" + ESC + "?1000l" + ESC + "?25h" + ESC + "?1049l");
  try { process.stdin.setRawMode(false); } catch {}
  if (cmds) spawn(process.execPath, [__filename, "--exec", JSON.stringify(cmds)], { detached: true, stdio: "ignore", env: process.env }).unref();
  process.exit(0);
}

const KEYMAP = { "ㅂ": "q", "ㅗ": "h", "ㅓ": "j", "ㅏ": "k", "ㅣ": "l", "ㅕ": "u" };

function onKey(st, k) {
  k = KEYMAP[k] ?? k;
  ui.msg = "";
  if (dragging() && k === "esc") { stopDrag(); return render(st); } // Esc drops the drag, not the popup
  if (!dragging() && k === "u") return undo(st);
  if (k === "\x03" || k === "q") return finish(st, false);
  if (ui.focus === "overview") {
    const dir = { up: "up", k: "up", down: "down", j: "down", left: "left", h: "left", right: "right", l: "right" }[k];
    if (dir) ovMove(st, dir);
    else if (k === "enter") {
      const row = selRow();
      if (row.kind === "newtab" || row.kind === "newws") return finish(st, true);
      if (dropPanes(st, row).length) { ui.focus = "map"; setRowFromSel(st); }
      else ui.msg = L.onlySelf;
    } else if (k === "esc") return finish(st, false);
  } else {
    if (k === "esc") { ui.focus = "overview"; ui.slot = null; ui.armed = null; ui.follow = true; }
    else if (k === "left" || k === "h") ui.slot.side = "left";
    else if (k === "right" || k === "l") ui.slot.side = "right";
    else if (k === "up" || k === "k") ui.slot.side = "up";
    else if (k === "down" || k === "j") ui.slot.side = "down";
    else if (k === " ") {
      if (selRow().tab.tab_id !== st.tp.tab_id) ui.msg = L.swapSameTab;
      else ui.slot.side = ui.slot.side === "swap" ? "right" : "swap";
    }
    else if (k === "tab") cyclePane(st, 1);
    else if (k === "btab") cyclePane(st, -1);
    else if (/^[1-9]$/.test(k)) {
      const lay = layoutOf(st, selRow().tab);
      const lp = lay.panes[Number(k) - 1];
      if (lp && lp.pane_id !== st.target) ui.slot = { pane: lp.pane_id, side: ui.slot?.side || "right" };
    } else if (k === "enter") return finish(st, true);
  }
  render(st);
}

function paneAt(st, x, y) {
  const h = ui.hits.find(({ r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  return h ? paneById(st, h.pane) : null;
}

function tileAt(x, y) {
  return ui.focus === "overview" ? ui.tiles.find(({ r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) : null;
}

function onMouse(st, b, x, y, release) {
  x -= 1; y -= 1;
  const wheel = b & 64, motion = b & 32;
  if (wheel) {
    if (ui.focus === "overview") { ui.ovTop = Math.max(0, ui.ovTop + ((b & 1) ? 1 : -1)); render(st); }
    return;
  }
  if ((b & 3) !== 0 && !(motion && (b & 3) === 3)) return; // left button (or plain motion) only
  const t = tileAt(x, y);
  if (release) {
    const d = ui.drag;
    stopDrag();
    if (!d) return;
    if (d.active) return d.slot ? dropDragged(st, d) : render(st);
    return click(st, x, y, t);
  }
  if (motion && (b & 3) === 0 && ui.drag) {
    // button held: past two cells it is a drag; the ghost and the chip follow the pointer
    const d = ui.drag;
    if (!d.active && Math.abs(x - d.x) + Math.abs(y - d.y) < 2) return;
    d.active = true; d.mx = x; d.my = y;
    aimDrag(st);
    edgeScroll(st);
    ui.hover = null; ui.msg = "";
    return render(st);
  }
  if (motion) {
    // plain hover: a tile picks itself; a pane only lights up, to show it can be dragged
    if (t) {
      if (t.i !== ui.sel || ui.hover) { ui.sel = t.i; ui.hover = null; ui.msg = ""; render(st); }
      return;
    }
    const id = paneAt(st, x, y)?.pane_id || null;
    if (id !== ui.hover) { ui.hover = id; render(st); }
    return;
  }
  // button down: on a pane it may become a drag, so wait for the release to decide
  const p = !t && paneAt(st, x, y);
  if (p) { ui.drag = { src: p, x, y, mx: x, my: y, active: false, slot: null }; return; }
  click(st, x, y, t);
}

// Point the drag at whatever is under the pointer: a "+ new" tile or a pane edge.
function aimDrag(st) {
  const d = ui.drag, t = tileAt(d.mx, d.my), tr = t && ui.rows[t.i];
  d.slot = tr && (tr.kind === "newtab" || tr.kind === "newws") ? { tile: t.i } : slotAt(st, d.mx, d.my, d.src);
  const i = d.slot ? (d.slot.tile ?? d.slot.i) : undefined;
  if (i !== undefined) ui.sel = i; // the target workspace gets the blue band
}

// Holding a drag on the overview's top or bottom rows keeps scrolling it, so off-screen workspaces are reachable.
let scrollTimer = null;
function edgeScroll(st) {
  const top = 3, bottom = H - 5; // the overview's first and last rows (see render)
  const dir = ui.focus !== "overview" ? 0 : ui.drag.my <= top ? -1 : ui.drag.my >= bottom ? 1 : 0;
  if (!dir) { clearInterval(scrollTimer); scrollTimer = null; return; }
  if (scrollTimer && scrollTimer.dir === dir) return;
  clearInterval(scrollTimer);
  scrollTimer = setInterval(() => {
    if (!dragging()) return stopDrag();
    const before = ui.ovTop;
    ui.ovTop = Math.max(0, ui.ovTop + dir);
    render(st); // clamps ovTop and redraws the hit areas under the pointer
    if (ui.ovTop === before) return;
    aimDrag(st);
    render(st);
  }, 150);
  scrollTimer.dir = dir;
}

function stopDrag() {
  ui.drag = null;
  clearInterval(scrollTimer); scrollTimer = null;
}

// A click that did not become a drag: tiles act, a pane in the overview picks its tab.
function click(st, x, y, t) {
  if (t) {
    const r = ui.rows[t.i];
    ui.sel = t.i; ui.slot = null; ui.msg = "";
    if (r.kind === "newtab" || r.kind === "newws") return finish(st, true);
    if (dropPanes(st, r).length) { ui.focus = "map"; setRowFromSel(st); }
    else ui.msg = L.onlySelf;
    return render(st);
  }
  const h = ui.hits.find(({ r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  if (h && h.i !== undefined && h.i !== ui.sel) { ui.sel = h.i; render(st); }
}

// Run a drag's move right away and keep the popup open on the new layout.
function dropDragged(st, d) {
  ui.msg = L.moving(paneName(d.src));
  render(st);

  setImmediate(() => runDrop(st, d));
}

const termOf = (p) => p.terminal_id || p.pane_id; // stays the same when herdr renumbers a moved pane
const byTerm = (st, k) => st.panes.find((p) => termOf(p) === k);

// Where a pane sits now, as a recipe to put it back: beside a neighbor in its tab, or alone in a new tab or workspace.
function spotOf(st, src) {
  const ws = st.workspaces.find((w) => w.workspace_id === src.workspace_id);
  const tab = ws && ws.tabs.find((t) => t.tab_id === src.tab_id);
  const lay = tab && layoutOf(st, tab);
  const spot = { term: termOf(src), name: paneName(src), ws: src.workspace_id, tabLabel: tab && tab.label };
  const me = lay && lay.panes.find((q) => q.pane_id === src.pane_id);
  const others = lay ? lay.panes.filter((q) => q.pane_id !== src.pane_id) : [];
  if (!me || !others.length) return { ...spot, alone: ws && ws.tabs.length > 1 ? "tab" : "ws" };
  const R = me.rect, near = (a, b) => Math.abs(a - b) <= 1;
  const cands = [];
  for (const q of others) {
    const Q = q.rect;
    const vOv = Math.min(R.y + R.height, Q.y + Q.height) - Math.max(R.y, Q.y) > 0;
    const hOv = Math.min(R.x + R.width, Q.x + Q.width) - Math.max(R.x, Q.x) > 0;
    const sameRow = near(Q.y, R.y) && near(Q.height, R.height), sameCol = near(Q.x, R.x) && near(Q.width, R.width);
    if (near(Q.x + Q.width, R.x) && vOv) cands.push({ q, side: "right", exact: sameRow });
    if (near(Q.y + Q.height, R.y) && hOv) cands.push({ q, side: "down", exact: sameCol });
    if (near(R.x + R.width, Q.x) && vOv) cands.push({ q, side: "left", exact: sameRow });
    if (near(R.y + R.height, Q.y) && hOv) cands.push({ q, side: "up", exact: sameCol });
  }
  const c = cands.find((x) => x.exact) || cands[0];
  if (!c) return { ...spot, alone: "tab" };
  return { ...spot, near: termOf(paneById(st, c.q.pane_id) || { pane_id: c.q.pane_id }), side: c.side };
}

function undoCmds(st, u) {
  const src = byTerm(st, u.term);
  if (!src) return null;
  if (u.alone === "tab" && st.workspaces.some((w) => w.workspace_id === u.ws))
    return [["pane", "move", src.pane_id, "--new-tab", "--workspace", u.ws, "--no-focus"]];
  if (u.alone) return [["pane", "move", src.pane_id, "--new-workspace", "--no-focus"]];
  const q = byTerm(st, u.near);
  return q ? placeCmds(src, q.tab_id, { pane: q.pane_id, side: u.side }, "--no-focus") : null;
}

function undo(st) {
  const u = ui.undo.pop();
  if (!u) { ui.msg = L.nothingToUndo; return render(st); }
  const cmds = undoCmds(st, u);
  if (!cmds) { ui.msg = L.undoLost(u.name); return render(st); }
  ui.msg = L.moving(u.name);
  render(st);
  setImmediate(() => {
    if (!runMove(st, cmds, L.undone(u.name)) || !u.alone || !u.tabLabel) return;
    // a pane that had a tab to itself comes back in a fresh tab: give it the old tab's name
    const p = byTerm(st, u.term), tab = p && st.workspaces.flatMap((w) => w.tabs).find((t) => t.tab_id === p.tab_id);
    if (tab && spawnSync(herdr, ["tab", "rename", tab.tab_id, u.tabLabel], { encoding: "utf8" }).status === 0) { tab.label = u.tabLabel; render(st); }
  });
}

function runDrop(st, d) {
  const T = d.src.pane_id, tile = d.slot.tile !== undefined && ui.rows[d.slot.tile];
  const cmds = !tile ? placeCmds(d.src, paneById(st, d.slot.pane).tab_id, d.slot, "--no-focus")
    : tile.kind === "newtab" ? [["pane", "move", T, "--new-tab", "--workspace", tile.ws.workspace_id, "--no-focus"]]
    : [["pane", "move", T, "--new-workspace", "--no-focus"]];
  const spot = spotOf(st, d.src);
  if (runMove(st, cmds, L.dragged(paneName(d.src)))) ui.undo.push(spot);
}

// Run herdr commands, then read the layout again and redraw. Returns true when every command succeeded.
function runMove(st, cmds, okMsg) {
  let err = "";
  for (const args of cmds) {
    const r = spawnSync(herdr, args, { encoding: "utf8" });
    if (r.status !== 0) { err = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`; break; }
  }
  // Pane ids can change when a pane moves, so find the popup's own pane again by its terminal.
  const term = termOf(st.tp), selTab = selRow()?.tab?.tab_id;
  try {
    const fresh = gather(st.target);
    const tp = fresh.panes.find((p) => termOf(p) === term) || fresh.tp;
    if (tp) { fresh.tp = tp; fresh.target = tp.pane_id; }
    Object.assign(st, fresh);
  } catch (e) { err = err || e.message; }
  ui.rows = buildRows(st);
  const i = ui.rows.findIndex((r) => r.kind === "tab" && r.tab.tab_id === selTab);
  ui.sel = i >= 0 ? i : Math.min(ui.sel, ui.rows.length - 1);
  if (ui.focus === "map" && selRow().kind !== "tab") ui.focus = "overview";
  ui.slot = null; ui.armed = null; ui.hover = null;
  ui.msg = err ? L.dragFailed(err) : okMsg;
  render(st);
  return !err;
}

function parse(st, s) {
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[([ABCDZ])|\x1b|\r|\n|\t|[\s\S]/gu;
  let m;
  const lone = s === "\x1b";
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) onMouse(st, +m[1], +m[2], +m[3], m[4] === "m");
    else if (m[5]) onKey(st, { A: "up", B: "down", C: "right", D: "left", Z: "btab" }[m[5]]);
    else if (m[0] === "\x1b") { if (lone) onKey(st, "esc"); }
    else if (m[0] === "\r" || m[0] === "\n") onKey(st, "enter");
    else if (m[0] === "\t") onKey(st, "tab");
    else onKey(st, m[0]);
    if (done) return;
  }
}

// ---------- main ----------

function main() {
  const dump = process.argv[2] === "--dump"; // --dump W H [paneId] [rowIndex] [slotPane side [overview]]
  let st;
  try { st = gather(dump ? process.argv[5] : null); }
  catch (e) { process.stderr.write("pane-easy-move: " + e.message + "\n"); process.exit(1); }
  if (!st.tp) { process.stderr.write("pane-easy-move: " + L.noTarget + "\n"); process.exit(1); }
  ui.rows = buildRows(st);
  ui.sel = Math.max(0, ui.rows.findIndex((r) => r.kind === "tab" && r.tab.tab_id === st.tp.tab_id));
  if (dump) {
    process.stdout.columns = +process.argv[3]; process.stdout.rows = +process.argv[4];
    if (process.argv[6]) ui.sel = +process.argv[6];
    if (process.argv[7]) { ui.focus = process.argv[9] === "overview" ? "overview" : "map"; ui.slot = { pane: process.argv[7], side: process.argv[8] || "right" }; }
    render(st);
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(ESC + "?1049h" + ESC + "?25l" + ESC + "?1000h" + ESC + "?1003h" + ESC + "?1006h");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => parse(st, d));
  process.stdout.on("resize", () => render(st));
  render(st);
}
main();
