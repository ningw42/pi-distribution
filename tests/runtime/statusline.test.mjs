import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { getPiRuntime } from "../helpers/pi-runtime.mjs";

// Use Pi's independently locked loader and real ANSI/column-width utilities.
const runtime = getPiRuntime();
const { createJiti } = await import(pathToFileURL(runtime.resolve("jiti")));
const tui = await import(pathToFileURL(runtime.resolve("@earendil-works/pi-tui")));
const { truncateToWidth, visibleWidth } = tui;
const RESET = "\x1b[0m";
const color = (rgb, text) => `\x1b[38;2;${rgb}m${text}${RESET}`;
const starship = {
  directory: color("137;180;250", "~/项目/e\u0301/😀"),
  git_branch: color("166;227;161", "main"),
  git_status: "[!]",
  git_metrics: "+12 -3",
};
const left = Object.values(starship).join(" ");
const segments = {
  cost: color("148;226;213", "$1.25"),
  tokens: color("116;199;236", "↑10k (\u{f0b86} 2k \u{f191f} 80.0%) ↓300"),
  context: color("242;205;205", "\uee03\uee04\uee04\uee01\uee01\uee01\uee01\uee01\uee01\uee02 25% 32k/128k"),
  model: color("235;160;172", "Test Model"),
  effort: color("235;160;172", "high"),
};
const right = [segments.cost, segments.tokens, segments.context, segments.model, segments.effort].join(" ");
const minimumWidth = visibleWidth(left) + 1 + visibleWidth(right);
const mobileRows = [
  left,
  `${segments.tokens} ${segments.cost}`,
  `${segments.model} ${segments.effort} ${segments.context}`,
];

async function createFooter(t) {
  const execFile = t.mock.method(childProcess, "execFile", (_command, args, _options, callback) => {
    queueMicrotask(() => callback(null, starship[args[1]] ?? ""));
  });
  syncBuiltinESMExports();
  t.after(() => {
    execFile.mock.restore();
    syncBuiltinESMExports();
  });
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    virtualModules: { "@earendil-works/pi-tui": tui },
  });
  const extension = await jiti.import("../../extensions/pi-statusline/index.ts", { default: true });
  const handlers = new Map();
  let footer;
  let requestRender;
  const leftReady = new Promise((resolve) => { requestRender = resolve; });
  const ctx = {
    cwd: process.cwd(),
    model: { name: "Test Model", contextWindow: 128_000 },
    getContextUsage: () => ({ percent: 25, tokens: 32_000, contextWindow: 128_000 }),
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1_000, cacheRead: 8_000, cacheWrite: 1_000, output: 300, cost: { total: 1.25 } },
        },
      }],
    },
    ui: {
      setFooter(factory) {
        footer = factory({ requestRender }, {}, { onBranchChange: () => () => {} });
      },
    },
  };
  extension({
    on: (event, handler) => handlers.set(event, handler),
    getThinkingLevel: () => "high",
  });
  const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
  t.after(async () => {
    await emit("session_shutdown");
    footer?.dispose();
  });
  await emit("session_start");
  await leftReady;
  return { footer, ctx, emit };
}

function desktopRow(width) {
  return truncateToWidth(left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right, width);
}

test("preserves the existing single-line text, colors, order, and right alignment", async (t) => {
  const { footer } = await createFooter(t);
  const width = minimumWidth + 30;
  assert.deepEqual(footer.render(width), [desktopRow(width)]);
  assert.equal(visibleWidth(footer.render(width)[0]), width);
});

test("switches at the actual display width, including the one-column gap", async (t) => {
  const { footer } = await createFooter(t);
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
  assert.deepEqual(footer.render(minimumWidth - 1), mobileRows);
});

test("uses Starship, tokens-cost, and model-effort-context rows on mobile", async (t) => {
  const { footer } = await createFooter(t);
  const width = Math.max(...mobileRows.map(visibleWidth));
  assert.ok(width < minimumWidth);
  assert.deepEqual(footer.render(width), mobileRows);
});

test("truncates each row independently without wrapping or exceeding the width", async (t) => {
  const { footer } = await createFooter(t);
  for (const width of [0, 1, 2, 10, 20, 40]) {
    const rows = footer.render(width);
    assert.deepEqual(rows, mobileRows.map((row) => truncateToWidth(row, width)));
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `row exceeds ${width} columns`);
      assert.equal(row.includes("\n"), false);
    }
  }
});

test("recalculates layout when resizing in either direction without invalidation", async (t) => {
  const { footer } = await createFooter(t);
  for (const width of [minimumWidth + 20, minimumWidth - 1, 20, minimumWidth, minimumWidth + 40]) {
    assert.deepEqual(
      footer.render(width),
      width >= minimumWidth
        ? [desktopRow(width)]
        : mobileRows.map((row) => truncateToWidth(row, width)),
    );
  }
});

test("recalculates the fit when content changes at a fixed terminal width", async (t) => {
  const { footer, ctx } = await createFooter(t);
  assert.equal(footer.render(minimumWidth).length, 1);
  ctx.model.name += " Extended";
  const rows = footer.render(minimumWidth);
  assert.equal(rows.length, 3);
  assert.equal(rows[2], `${color("235;160;172", "Test Model Extended")} ${segments.effort} ${segments.context}`);
  ctx.model.name = "Test Model";
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
});

test("keeps the generation suffix attached to tokens before cost in multiline mode", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  now += 1_500;
  const tokens = segments.tokens.replace(RESET, ` (\u{f199f} 1.5s)${RESET}`);
  assert.deepEqual(footer.render(minimumWidth), [
    left,
    `${tokens} ${segments.cost}`,
    mobileRows[2],
  ]);
});
