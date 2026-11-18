#!/usr/bin/env node
// Pane Map: move the current pane by pointing at a drawn map.
// Left: every workspace and its tabs. Right: the selected tab drawn to scale.
// Pick a pane in the map and a side (or the center to swap); a ghost shows
// where the moving pane will land, and the bottom line says it in words.
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
      const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? "/tmp/herdr-pane-map";
      fs.writeFileSync(path.join(dir, "last-exec.json"), JSON.stringify(log, null, 1));
    } catch {}
    process.exit(0);
  }, 200);
  return;
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? "/tmp/herdr-pane-map";

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

// List rows: workspace headers, tabs, "new tab" per workspace, "new workspace".
function buildRows(st) {
  const rows = [];
  for (const ws of st.workspaces) {
    rows.push({ kind: "ws", ws });
    for (const tab of ws.tabs) rows.push({ kind: "tab", ws, tab });
    rows.push({ kind: "newtab", ws });
  }
  rows.push({ kind: "newws" });
  return rows;
}

const ui = {
  rows: [], sel: 0, top: 0,
  focus: "list",        // "list" | "map"
  slot: null,           // { pane: paneId, side: "left"|"right"|"up"|"down"|"swap" }
  armed: null,          // slot key that a click will execute
  hits: [],             // map pane rects on screen for mouse
  listX: 0, listW: 0, listY: 0, listH: 0,
  msg: "",
};

// ---------- messages (English default; set language = "ko" in config.toml) ----------

function loadLang() {
  if (process.env.HERDR_PANE_MAP_LANG) return process.env.HERDR_PANE_MAP_LANG;
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
    pickHint: "Pick a tab or '+ new tab' to draw it here.",
    newTabBox: (ws) => `New tab (${ws})`,
    newWsBox: "New workspace",
    alone: (name) => `'${name}' gets the whole screen`,
    noLayout: "Could not read this tab's layout.",
    movingHere: "<- the pane you are moving (leaves here)",
    swapBox: (name) => `⇄ swap with '${name}'`,
    here: "here",
    onlySelf: "This tab only holds the pane you are moving. Pick another tab.",
    title: "Move pane",
    now: "Now at: ",
    listHead: "Workspaces / tabs",
    keysList: "↑↓ pick tab · → or Enter to the map · or just click · Esc close",
    keysMap: "←↑→↓ side · Tab/number target pane · Space swap · Enter move · Esc back",
    pickFirst: "Pick a spot first.",
    noTargets: "No pane to attach to in this tab.",
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
    pickHint: "탭이나 '+ 새 탭'을 고르면 여기에 그 탭이 그려져.",
    newTabBox: (ws) => `새 탭 (${ws})`,
    newWsBox: "새 워크스페이스",
    alone: (name) => `'${name}' 혼자 화면을 다 써`,
    noLayout: "이 탭의 배치를 읽지 못했어.",
    movingHere: "← 지금 옮기려는 pane (여기서 빠져)",
    swapBox: (name) => `⇄ '${name}'와 자리 바꿈`,
    here: "여기로",
    onlySelf: "이 탭에는 옮길 pane 자신만 있어. 다른 탭을 골라.",
    title: "pane 옮기기",
    now: "지금 위치: ",
    listHead: "워크스페이스 / 탭",
    keysList: "↑↓ 탭 고르기 · → 또는 Enter 지도로 · 마우스로 바로 찍어도 돼 · Esc 닫기",
    keysMap: "←↑→↓ 붙일 쪽 · Tab/숫자 기준 pane · Space 자리 바꾸기 · Enter 실행 · Esc 목록으로",
    pickFirst: "먼저 붙일 자리를 골라.",
    noTargets: "이 탭에는 붙일 pane이 없어.",
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

function drawList(st) {
  const { listX: x0, listY: y0, listW: w, listH: h } = ui;
  if (ui.sel < ui.top) ui.top = ui.sel;
  if (ui.sel >= ui.top + h) ui.top = ui.sel - h + 1;
  for (let i = 0; i < h; i++) {
    const r = ui.rows[ui.top + i];
    if (!r) break;
    const y = y0 + i;
    const on = ui.top + i === ui.sel;
    let text, st0 = "";
    if (r.kind === "ws") { text = `${r.ws.number} ${r.ws.label}`; st0 = S.bold; }
    else if (r.kind === "tab") {
      const here = r.tab.tab_id === st.tp.tab_id;
      text = `  ${here ? "●" : " "} ${r.tab.label || L.tabWord} ${r.tab.pane_count > 1 ? "·" + r.tab.pane_count : ""}`;
      if (here) st0 = S.orange;
    }
    else if (r.kind === "newtab") { text = "    " + L.newTab; st0 = S.dim; }
    else { text = L.newWs; st0 = S.dim; }
    text = fit(text, w);
    if (on) {
      const focusSt = ui.focus === "list" ? S.inv : S.inv + S.dim;
      put(x0, y, text + " ".repeat(Math.max(0, w - strW(text))), focusSt);
    } else put(x0, y, text, st0);
  }
  if (ui.top > 0) put(x0 + w - 1, y0, "▲", S.dim);
  if (ui.top + h < ui.rows.length) put(x0 + w - 1, y0 + h - 1, "▼", S.dim);
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
  if (!row || row.kind === "ws") {
    put(x0, y0 + 1, L.pickHint, S.dim);
    return;
  }
  if (row.kind === "newtab" || row.kind === "newws") {
    const r = { x: x0, y: y0, w: Math.min(w, 60), h: Math.min(h, 12) };
    fill(r.x, r.y, r.w, r.h, S.ghostSoft);
    box(r.x, r.y, r.w, r.h, S.blue);
    centerText(r, r.y + Math.floor(r.h / 2) - 1, row.kind === "newtab" ? L.newTabBox(row.ws.label) : L.newWsBox, S.ghostSoft + S.bold);
    centerText(r, r.y + Math.floor(r.h / 2), L.alone(paneName(st.tp)), S.ghostSoft);
    return;
  }
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
    if (isSlot) {
      const g = ghostRect(r, ui.slot.side);
      if (ui.slot.side === "swap") {
        fill(g.x + 1, g.y + 1, g.w - 2, g.h - 2, S.ghostSoft);
        box(g.x, g.y, g.w, g.h, S.blue);
        centerText(g, g.y + Math.floor(g.h / 2), L.swapBox(fit(paneName(st.tp), 16)), S.ghostSoft + S.bold);
      } else {
        fill(g.x, g.y, g.w, g.h, S.ghost);
        box(g.x, g.y, g.w, g.h, S.ghost);
        const arrow = { left: "◀", right: "▶", up: "▲", down: "▼" }[ui.slot.side];
        centerText(g, g.y + Math.floor(g.h / 2) - (g.h > 4 ? 1 : 0), `${arrow} ${L.here}`, S.ghost);
        if (g.h > 4) centerText(g, g.y + Math.floor(g.h / 2), fit(paneName(st.tp), 20), S.ghost);
      }
    }
  });
  if (!dropPanes(st, row).length)
    put(x0, y0 + h, L.onlySelf, S.dim);
}

function render(st) {
  clear();
  const listW = Math.max(22, Math.min(40, Math.floor(W * 0.28)));
  Object.assign(ui, { listX: 1, listY: 3, listW, listH: H - 7 });
  const tx = put(1, 0, L.title + "  ", S.bold);
  put(put(tx, 0, L.now, S.dim), 0,
    `${tabTitle(st.workspaces.find((w) => w.workspace_id === st.tp.workspace_id), st.workspaces.flatMap((w) => w.tabs).find((t) => t.tab_id === st.tp.tab_id) || { number: "?" })} · '${paneName(st.tp)}'`, S.orange);
  put(1, 2, L.listHead, ui.focus === "list" ? S.bold : S.dim);
  const mx = listW + 4, mw = W - mx - 2;
  const row = selRow();
  put(mx, 2, row?.kind === "tab" ? fit(tabTitle(row.ws, row.tab), mw) : "", ui.focus === "map" ? S.bold : S.dim);
  for (let y = 2; y < H - 3; y++) put(listW + 2, y, "│", S.dim);
  drawList(st);
  drawMap(st, mx, 3, mw, H - 8);
  // bottom: the action in words, then keys
  const d = describe(st);
  put(1, H - 3, d ? "→ " + fit(d, W - 4) : "", S.blue);
  const keys = ui.focus === "list"
    ? L.keysList
    : L.keysMap;
  put(1, H - 2, fit(keys, W - 2), S.dim);
  if (ui.msg) put(1, H - 1, fit(ui.msg, W - 2), S.orange);
  flush();
}

// ---------- input ----------

function setRowFromSel(st) {
  ui.slot = ui.focus === "map" ? defaultSlot(st, selRow()) : null;
  ui.armed = null;
}

function moveSel(st, d) {
  let i = ui.sel;
  do { i += d; } while (i >= 0 && i < ui.rows.length && ui.rows[i].kind === "ws");
  if (i >= 0 && i < ui.rows.length) ui.sel = i;
  ui.slot = null; ui.armed = null;
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
    if (h.sameTab && Math.abs(u - 0.5) < 0.2 && Math.abs(v - 0.5) < 0.2) return { pane: h.pane, side: "swap" };
    const d = { left: u, right: 1 - u, up: v, down: 1 - v };
    const side = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
    return { pane: h.pane, side };
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
  if (ui.focus === "list") {
    if (k === "up" || k === "k") moveSel(st, -1);
    else if (k === "down" || k === "j") moveSel(st, 1);
    else if (k === "right" || k === "l" || k === "tab" || k === "enter") {
      const row = selRow();
      if (row.kind === "newtab" || row.kind === "newws") { if (k === "enter") return finish(st, true); }
      else if (dropPanes(st, row).length) { ui.focus = "map"; setRowFromSel(st); }
      else ui.msg = L.noTargets;
    } else if (k === "esc") return finish(st, false);
  } else {
    if (k === "esc") { ui.focus = "list"; ui.slot = null; }
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
  if (wheel) { if (x < ui.listW + 2) { moveSel(st, (b & 1) ? 1 : -1); if (ui.focus === "map") { ui.focus = "list"; } render(st); } return; }
  if (release) return;
  const inList = x >= ui.listX && x < ui.listX + ui.listW && y >= ui.listY && y < ui.listY + ui.listH;
  if (motion) {
    // hover in the map previews the drop spot
    const s = slotAt(x, y);
    if (s && slotKey(s) !== slotKey(ui.slot)) { ui.focus = "map"; ui.slot = s; ui.armed = slotKey(s); render(st); }
    return;
  }
  if ((b & 3) !== 0) return; // left button only
  if (inList) {
    const i = ui.top + (y - ui.listY);
    const r = ui.rows[i];
    if (!r || r.kind === "ws") return;
    if (ui.sel === i && (r.kind === "newtab" || r.kind === "newws")) return finish(st, true);
    ui.sel = i; ui.focus = "list"; ui.slot = null; ui.armed = null; ui.msg = "";
    return render(st);
  }
  const s = slotAt(x, y);
  if (!s) return;
  if (ui.armed === slotKey(s)) { ui.slot = s; return finish(st, true); }
  ui.focus = "map"; ui.slot = s; ui.armed = slotKey(s);
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
  const dump = process.argv[2] === "--dump"; // --dump W H [paneId] [rowIndex] [slotPane side]
  let st;
  try { st = gather(dump ? process.argv[5] : null); }
  catch (e) { process.stderr.write("pane-map: " + e.message + "\n"); process.exit(1); }
  if (!st.tp) { process.stderr.write("pane-map: " + L.noTarget + "\n"); process.exit(1); }
  ui.rows = buildRows(st);
  ui.sel = Math.max(0, ui.rows.findIndex((r) => r.kind === "tab" && r.tab.tab_id === st.tp.tab_id));
  if (dump) {
    process.stdout.columns = +process.argv[3]; process.stdout.rows = +process.argv[4];
    if (process.argv[6]) ui.sel = +process.argv[6];
    if (process.argv[7]) { ui.focus = "map"; ui.slot = { pane: process.argv[7], side: process.argv[8] || "right" }; }
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
