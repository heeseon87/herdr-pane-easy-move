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
  ghostSoft: ESC + "38;2;44;85;196;48;2;214;224;248m",
  moving: ESC + "38;2;194;90;44;48;2;246;226;214m",
  pick: ESC + "38;2;44;85;196;48;2;228;234;248m",
};

let W = 100, H = 30, buf = [];
function clear() {
  W = process.stdout.columns || 100;
  H = process.stdout.rows || 30;
  buf = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: " ", st: "" })));
}
function put(x, y, s, st = "", maxX = W) {
  if (y < 0 || y >= H) return x;
  for (const c of s) {
    const k = cw(c.codePointAt(0));
    if (k === 0) continue;
    if (x + k > maxX || x + k > W) break;
    if (x >= 0) {
      buf[y][x] = { ch: c, st };
      if (k === 2) buf[y][x + 1] = { ch: "", st };
    }
    x += k;
  }
  return x;
}
function fill(x0, y0, w, h, st) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
    if (y >= 0 && y < H && x >= 0 && x < W) buf[y][x] = { ch: " ", st };
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
      if (c.st !== cur) { o += ESC + "0m" + c.st; cur = c.st; }
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
  follow: true,         // scroll the overview to the selection on the next render
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
    keysOverview: "←↑→↓ pick tab · Enter zoom in · wheel scrolls · point at a pane edge and click to move · Esc close",
    keysMap: "←↑→↓ side · Tab/number target pane · Space swap · Enter move · Esc back",
    pickFirst: "Pick a spot first.",
    swapSameTab: "Swap works only inside one tab (herdr limit).",
    clickAgain: "Click the same spot again, or press Enter, to move.",
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
    keysOverview: "←↑→↓ 탭 고르기 · Enter 크게 보기 · 휠로 스크롤 · pane 가장자리를 가리키고 클릭하면 옮겨 · Esc 닫기",
    keysMap: "←↑→↓ 붙일 쪽 · Tab/숫자 기준 pane · Space 자리 바꾸기 · Enter 실행 · Esc 전체 보기로",
    pickFirst: "먼저 붙일 자리를 골라.",
    swapSameTab: "자리 바꾸기는 같은 탭 안에서만 돼 (herdr 제약).",
    clickAgain: "같은 자리를 한 번 더 누르거나 Enter를 누르면 옮겨.",
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
  const P = ui.slot.pane, side = ui.slot.side;
  if (side === "swap") return [["pane", "swap", "--source-pane", T, "--target-pane", P]];
  const cmds = [];
  // herdr cannot re-split inside one tab, so bounce the pane out first.
  if (row.tab.tab_id === tp.tab_id)
    cmds.push(["pane", "move", T, "--new-tab", "--workspace", tp.workspace_id, "--no-focus"]);
  const base = side === "left" || side === "up" ? (side === "left" ? "right" : "down") : side;
  cmds.push(["pane", "move", T, "--tab", row.tab.tab_id, "--split", base, "--target-pane", P, "--focus"]);
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
    const isMe = lp.pane_id === st.target;
    const isSlot = ui.slot && ui.slot.pane === lp.pane_id;
    ui.hits.push({ pane: lp.pane_id, r, isMe, sameTab: row.tab.tab_id === st.tp.tab_id });
    if (isMe) fill(r.x, r.y, r.w, r.h, S.moving);
    box(r.x, r.y, r.w, r.h, isMe ? S.orange : isSlot ? S.blue : S.dim);
    const nameSt = isMe ? S.moving + S.bold : S.bold;
    put(r.x + 2, r.y + 1, fit(`${i + 1}  ${p ? paneName(p) : lp.pane_id}`, r.w - 4), nameSt, r.x + r.w - 1);
    if (r.h > 3) put(r.x + 2, r.y + 2, fit(isMe ? L.movingHere : path.basename(p?.cwd || ""), r.w - 4), isMe ? S.moving : S.dim, r.x + r.w - 1);
    if (isSlot) drawGhost(st, r);
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
  // Each workspace sits in a heavy frame: its first line carries the top border with the name, its last line the bottom border.
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

function drawGhost(st, r) {
  const g = ghostRect(r, ui.slot.side);
  if (ui.slot.side === "swap") {
    fill(g.x + 1, g.y + 1, g.w - 2, g.h - 2, S.ghostSoft);
    box(g.x, g.y, g.w, g.h, S.blue);
    centerText(g, g.y + Math.floor(g.h / 2), L.swapBox(fit(paneName(st.tp), 16)), S.ghostSoft + S.bold);
    return;
  }
  fill(g.x, g.y, g.w, g.h, S.ghost);
  box(g.x, g.y, g.w, g.h, S.ghost);
  const arrow = { left: "◀", right: "▶", up: "▲", down: "▼" }[ui.slot.side];
  centerText(g, g.y + Math.floor(g.h / 2) - (g.h > 4 ? 1 : 0), `${arrow} ${L.here}`, S.ghost);
  if (g.h > 4) centerText(g, g.y + Math.floor(g.h / 2), fit(paneName(st.tp), 20), S.ghost);
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
    const isMe = lp.pane_id === st.target;
    const isSlot = on && ui.slot && ui.slot.pane === lp.pane_id;
    ui.hits.push({ pane: lp.pane_id, r, isMe, sameTab: here, i });
    // The picked tab lights up pale blue, so it is clear which one Enter or a click acts on.
    if (isMe) fill(r.x, r.y, r.w, r.h, S.moving);
    else if (on) fill(r.x, r.y, r.w, r.h, S.pick);
    box(r.x, r.y, r.w, r.h, isMe ? S.orange : on ? S.pick : S.dim);
    // The name sits on the top border, as herdr draws pane labels, so a 2-row pane still shows it.
    if (r.w >= 5) put(r.x + 1, r.y, fit(`${n + 1} ${p ? paneName(p) : ""}`, r.w - 2), isMe ? S.orange : on ? S.pick + S.bold : S.n, r.x + r.w - 1);
    if (isSlot) ghostAt = r;
  });
  if (ghostAt) drawGhost(st, ghostAt);
}

// "+ new tab" / "+ new workspace". Picked, it opens into a ghost of the pane landing there alone.
// "+ new tab" / "+ new workspace", drawn at the size of a tab. Picked, it fills with a ghost of the pane landing there alone.
function newTile(st, i, label, x, y, w, h, on) {
  const t = fit(`${on ? "▶ " : ""}${label}`, w);
  put(x, y, on ? t + " ".repeat(Math.max(0, w - strW(t))) : t, on ? S.inv : S.dim);
  const r = { x, y: y + 1, w, h };
  const mid = r.y + Math.floor(r.h / 2);
  if (on) {
    fill(r.x, r.y, r.w, r.h, S.ghost);
    box(r.x, r.y, r.w, r.h, S.ghost);
    centerText(r, mid - 1, `▶ ${L.here}`, S.ghost);
    centerText(r, mid, fit(paneName(st.tp), r.w - 4), S.ghost);
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
      // heavy frame around the workspace; blue when it holds the picked tab
      const picked = ui.rows[ui.sel]?.ws === line.ws;
      const fst = picked ? S.blue : S.n;
      const fh = line.h - (line.last ? 1 : 0);
      for (let yy = y; yy < y + fh; yy++) { put(x0, yy, "┃", fst); put(x0 + w - 1, yy, "┃", fst); }
      if (line.first) {
        put(x0, y, "┏" + "━".repeat(w - 2) + "┓", fst);
        put(x0 + 2, y, ` ${fit(`${line.ws.number} ${line.ws.label}`, w - 8)} `, line.ws.workspace_id === st.tp.workspace_id ? S.orange : picked ? S.blue : S.bold);
        ty = y + 1;
      } else if (l === ui.ovTop) {
        // scrolled into the middle of a workspace: name it on the row above
        put(x0, y0 - 1, fit(`${line.ws.number} ${line.ws.label} …`, w - strW(L.moreAbove) - 4), S.dim);
      }
      if (line.last) put(x0, y + fh - 1, "┗" + "━".repeat(w - 2) + "┛", fst);
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
  let d = describe(st);
  if (!d && ui.focus === "overview" && row?.kind === "tab") d = L.zoomHint(tabTitle(row.ws, row.tab));
  put(1, H - 3, d ? "→ " + fit(d, W - 4) : "", S.blue);
  put(1, H - 2, fit(ui.focus === "map" ? L.keysMap : L.keysOverview, W - 2), S.dim);
  if (ui.msg) put(1, H - 1, fit(ui.msg, W - 2), S.orange);
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

function slotAt(x, y) {
  for (const h of ui.hits) {
    const { r } = h;
    if (h.isMe || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
    const u = (x - r.x + 0.5) / r.w, v = (y - r.y + 0.5) / r.h;
    // herdr swaps only inside one tab, so the center (swap) zone exists only there.
    if (h.sameTab && Math.abs(u - 0.5) < 0.2 && Math.abs(v - 0.5) < 0.2) return { pane: h.pane, side: "swap", i: h.i };
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

const KEYMAP = { "ㅂ": "q", "ㅗ": "h", "ㅓ": "j", "ㅏ": "k", "ㅣ": "l" };

function onKey(st, k) {
  k = KEYMAP[k] ?? k;
  ui.msg = "";
  if (k === "\x03" || k === "q") return finish(st, false);
  if (ui.focus === "overview") {
    const dir = { up: "up", k: "up", down: "down", j: "down", left: "left", h: "left", right: "right", l: "right" }[k];
    if (dir) ovMove(st, dir);
    else if (k === "enter") {
      const row = selRow();
      if (ui.slot && ui.armed) return finish(st, true); // a spot already picked with the mouse
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

function onMouse(st, b, x, y, release) {
  x -= 1; y -= 1;
  const wheel = b & 64, motion = b & 32;
  if (wheel) {
    if (ui.focus === "overview") { ui.ovTop = Math.max(0, ui.ovTop + ((b & 1) ? 1 : -1)); render(st); }
    return;
  }
  if (release) return;
  // overview titles and "+ new" tiles: hover picks one, a click acts on it
  const t = ui.focus === "overview" && ui.tiles.find(({ r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  if (motion) {
    if (t) {
      if (t.i !== ui.sel || ui.slot) { ui.sel = t.i; ui.slot = null; ui.armed = null; ui.msg = ""; render(st); }
      return;
    }
    // hover over a pane previews the drop spot; in the overview it also picks that tab
    const s = slotAt(x, y);
    if (s && slotKey(s) !== slotKey(ui.slot)) {
      if (s.i !== undefined) ui.sel = s.i;
      ui.slot = s; ui.armed = slotKey(s); render(st);
    }
    return;
  }
  if ((b & 3) !== 0) return; // left button only
  if (t) {
    const r = ui.rows[t.i];
    ui.sel = t.i; ui.slot = null; ui.armed = null; ui.msg = "";
    if (r.kind === "newtab" || r.kind === "newws") return finish(st, true);
    if (dropPanes(st, r).length) { ui.focus = "map"; setRowFromSel(st); }
    else ui.msg = L.onlySelf;
    return render(st);
  }
  const s = slotAt(x, y);
  if (!s) return;
  if (s.i !== undefined) ui.sel = s.i;
  if (ui.armed === slotKey(s)) { ui.slot = s; return finish(st, true); }
  ui.slot = s; ui.armed = slotKey(s);
  ui.msg = L.clickAgain;
  render(st);
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
