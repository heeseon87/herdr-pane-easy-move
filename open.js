#!/usr/bin/env node
// Action entrypoint: remember the pane to move, then open the map popup.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? "/tmp/herdr-pane-map";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "heeseon87.pane-map";

let target = process.env.HERDR_PANE_ID || null;
if (!target) {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    target = ctx.pane_id ?? ctx.focused_pane_id ?? ctx.pane?.pane_id ?? ctx.focused_pane?.pane_id ?? null;
  } catch {}
}
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "target.json"), JSON.stringify({ target, at: Date.now() }));

const res = spawnSync(herdr, ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "map"], { encoding: "utf8" });
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status ?? 0);
