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
  tokens: [
    color("116;199;236", "↑10k"),
    color("127;132;156", "(\u{f0b86} 2k \u{f191f} 80.0%)"),
    color("116;199;236", "↓300"),
  ].join(" "),
  context: color("242;205;205", "\uee03\uee04\uee04\uee01\uee01\uee01\uee01\uee01\uee01\uee02 25% 32k/128k"),
  model: color("235;160;172", "Test Model"),
  effort: color("250;179;135", "high"),
};
const right = [segments.cost, segments.tokens, segments.context, segments.model, segments.effort].join(" ");
const minimumWidth = visibleWidth(left) + 1 + visibleWidth(right);
const mobileRows = [
  `${segments.tokens} ${segments.cost}`,
  `${segments.model} ${segments.effort} ${segments.context}`,
  left,
];

async function createFooter(t, { entries, reason = "startup" } = {}) {
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
      getEntries: () => entries ?? [{
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
  await emit("session_start", { reason });
  await leftReady;
  return { get footer() { return footer; }, ctx, emit };
}

function desktopRow(width) {
  return truncateToWidth(left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right, width);
}

test("renders the single-line text, colors, order, and right alignment", async (t) => {
  const { footer } = await createFooter(t);
  const width = minimumWidth + 30;
  assert.deepEqual(footer.render(width), [desktopRow(width)]);
  assert.equal(visibleWidth(footer.render(width)[0]), width);
});

test("renders token details from usage for both new and resumed sessions", async (t) => {
  const assistantEntry = (usage) => ({
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: { total: 0 }, ...usage },
    },
  });
  const cases = [
    { name: "empty session", entries: [], input: "↑0", output: "↓0" },
    {
      name: "metadata without usage",
      entries: [{ type: "model_change", provider: "test", modelId: "test" }],
      input: "↑0", output: "↓0",
    },
    { name: "zero usage", entries: [assistantEntry({})], input: "↑0", output: "↓0" },
    {
      name: "output without input usage",
      entries: [assistantEntry({ output: 300 })],
      input: "↑0", output: "↓300",
    },
    {
      name: "fully cached input",
      entries: [assistantEntry({ cacheRead: 1_000, output: 300 })],
      input: "↑1k", details: "(\u{f191f} 100.0%)", output: "↓300",
    },
    {
      name: "ordinary input without cache writes",
      entries: [assistantEntry({ input: 1_000, output: 300 })],
      input: "↑1k", details: "(\u{f0b86} 1k \u{f191f} 0.0%)", output: "↓300",
    },
    {
      name: "cache writes without ordinary input",
      entries: [assistantEntry({ cacheWrite: 1_000, output: 300 })],
      input: "↑1k", details: "(\u{f0b86} 1k \u{f191f} 0.0%)", output: "↓300",
    },
    {
      name: "restored mixed usage",
      entries: [assistantEntry({ input: 1_000, cacheRead: 8_000, cacheWrite: 1_000, output: 300 })],
      input: "↑10k", details: "(\u{f0b86} 2k \u{f191f} 80.0%)", output: "↓300",
    },
  ];

  for (const reason of ["startup", "resume"]) {
    for (const fixture of cases) {
      await t.test(`${reason}: ${fixture.name}`, async (t) => {
        const { footer } = await createFooter(t, { entries: fixture.entries, reason });
        const tokens = [
          color("116;199;236", fixture.input),
          ...(fixture.details ? [color("127;132;156", fixture.details)] : []),
          color("116;199;236", fixture.output),
        ].join(" ");
        const cost = color("148;226;213", "$0.00");
        const expectedRight = [cost, tokens, segments.context, segments.model, segments.effort].join(" ");
        const width = visibleWidth(left) + 1 + visibleWidth(expectedRight);
        assert.deepEqual(footer.render(width), [truncateToWidth(`${left} ${expectedRight}`, width)]);
        assert.deepEqual(footer.render(width - 1), [`${tokens} ${cost}`, mobileRows[1], left]);
      });
    }
  }
});

test("shows input details when usage arrives after an empty render", async (t) => {
  const entries = [];
  const { footer, emit } = await createFooter(t, { entries });
  assert.ok(footer.render(200)[0].includes(`${color("116;199;236", "↑0")} ${color("116;199;236", "↓0")}`));
  const message = {
    role: "assistant",
    usage: { input: 1_000, cacheRead: 8_000, cacheWrite: 1_000, output: 300, cost: { total: 1.25 } },
  };
  entries.push({ type: "message", message });
  await emit("message_end", { message });
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
});

test("switches at the actual display width, including the one-column gap", async (t) => {
  const { footer } = await createFooter(t);
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
  assert.deepEqual(footer.render(minimumWidth - 1), mobileRows);
});

test("orders mobile rows by component update frequency", async (t) => {
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
  assert.equal(rows[1], `${color("235;160;172", "Test Model Extended")} ${segments.effort} ${segments.context}`);
  ctx.model.name = "Test Model";
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
});

test("keeps the generation suffix attached to tokens before cost in multiline mode", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  now += 1_500;
  const checkLayout = (suffix) => {
    const tokens = `${segments.tokens} ${suffix}`;
    const rows = [`${tokens} ${segments.cost}`, mobileRows[1], left];
    assert.deepEqual(footer.render(minimumWidth), rows);
    const combinedRight = [segments.cost, tokens, segments.context, segments.model, segments.effort].join(" ");
    const combinedWidth = visibleWidth(left) + 1 + visibleWidth(combinedRight);
    assert.deepEqual(footer.render(combinedWidth), [truncateToWidth(`${left} ${combinedRight}`, combinedWidth)]);
    for (let width = 0; width < combinedWidth; width++) {
      assert.deepEqual(footer.render(width), rows.map((row) => truncateToWidth(row, width)));
    }
  };
  checkLayout(generationSuffix("1.5s", "·", "ttft"));
  await emit("message_update", { assistantMessageEvent: { delta: "a".repeat(40) } });
  now += 500;
  await emit("message_update", { assistantMessageEvent: { delta: "b".repeat(40) } });
  checkLayout(generationSuffix("1.5s", "40", "tps"));
});

function generationSuffix(ttft, tps, active = null) {
  const highlight = (text) => `\x1b[38;2;249;226;175m${text}\x1b[38;2;127;132;156m`;
  const ttftText = `\u{f199f} ${ttft}`;
  const tpsText = `\u{f140b} ${tps} T/s`;
  return color("127;132;156", `(${active === "ttft" ? highlight(ttftText) : ttftText} ${active === "tps" ? highlight(tpsText) : tpsText})`);
}

function assertGeneration(footer, ttft, tps, active = null) {
  assert.ok(footer.render(250)[0].includes(`${segments.tokens} ${generationSuffix(ttft, tps, active)}`));
}

test("keeps TTFT beside live and finalized speed without repaint drift", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  assertGeneration(footer, "0.0s", "·", "ttft");
  now += 1_000;
  await emit("message_update", { assistantMessageEvent: { type: "text_start" } });
  assertGeneration(footer, "1.0s", "·", "ttft");
  now += 500;
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "a".repeat(40) } });
  assertGeneration(footer, "1.5s", "·");
  now += 500;
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "b".repeat(40) } });
  assertGeneration(footer, "1.5s", "40", "tps");
  // Unrelated messages don't end generation or remove its active color.
  await emit("message_end", { message: { role: "toolResult" } });
  assertGeneration(footer, "1.5s", "40", "tps");
  now += 500;
  await emit("message_update", { assistantMessageEvent: { delta: "c".repeat(40) } });
  // Speed can fall while still being actively measured.
  assertGeneration(footer, "1.5s", "30", "tps");
  now += 500;
  await emit("message_end", { message: { role: "assistant", usage: { output: 300 } } });
  assertGeneration(footer, "1.5s", "200");
  await emit("turn_end");
  await emit("agent_end");
  now += 60_000;
  assertGeneration(footer, "1.5s", "200");
});

test("rounds live and finalized speed to integers at every magnitude", async (t) => {
  const cases = [
    { name: "below one token per second", tokens: 1, elapsedMs: 3_000, expected: "0" },
    { name: "rounds down", tokens: 4, elapsedMs: 3_000, expected: "1" },
    { name: "rounds half up", tokens: 5, elapsedMs: 2_000, expected: "3" },
    { name: "rounds across 100", tokens: 199, elapsedMs: 2_000, expected: "100" },
    { name: "above 100", tokens: 201, elapsedMs: 2_000, expected: "101" },
  ];
  for (const { name, tokens, elapsedMs, expected } of cases) {
    await t.test(name, async (t) => {
      let now = 10_000;
      t.mock.method(Date, "now", () => now);
      const { footer, emit } = await createFooter(t);
      await emit("turn_start");
      now += 1_000;
      await emit("message_update", { assistantMessageEvent: { delta: "a" } });
      now += elapsedMs;
      await emit("message_update", { assistantMessageEvent: { delta: "b".repeat(tokens * 4 - 1) } });
      assertGeneration(footer, "1.0s", expected, "tps");
      await emit("message_end", { message: { role: "assistant", usage: { output: tokens } } });
      assertGeneration(footer, "1.0s", expected);
    });
  }
});

test("resets both readings for the next turn instead of showing stale speed", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  now += 1_000;
  await emit("message_update", { assistantMessageEvent: { delta: "a".repeat(40) } });
  now += 500;
  await emit("message_end", { message: { role: "assistant", usage: { output: 300 } } });
  assertGeneration(footer, "1.0s", "600");
  await emit("turn_end");
  now += 10_000;
  await emit("turn_start");
  assertGeneration(footer, "0.0s", "·", "ttft");
  now += 200;
  await emit("message_update", { assistantMessageEvent: { delta: "new turn" } });
  assertGeneration(footer, "0.2s", "·");
});

test("freezes TTFT on the first thinking or tool-call delta too", async (t) => {
  for (const type of ["thinking_delta", "toolcall_delta"]) {
    await t.test(type, async (t) => {
      let now = 10_000;
      t.mock.method(Date, "now", () => now);
      const { footer, emit } = await createFooter(t);
      await emit("turn_start");
      now += 1_000;
      await emit("message_update", { assistantMessageEvent: { type, delta: "a".repeat(40) } });
      now += 500;
      await emit("message_update", { assistantMessageEvent: { type, delta: "b".repeat(40) } });
      assertGeneration(footer, "1.0s", "40", "tps");
    });
  }
});

test("keeps both slots after ending without a first token, without inventing TTFT", async (t) => {
  for (const event of ["message_end", "turn_end", "agent_end"]) {
    await t.test(event, async (t) => {
      let now = 10_000;
      t.mock.method(Date, "now", () => now);
      const { footer, emit } = await createFooter(t);
      await emit("turn_start");
      now += 1_500;
      assertGeneration(footer, "1.5s", "·", "ttft");
      await emit(event, { message: { role: "assistant", stopReason: "error", usage: { output: 0 } } });
      now += 60_000;
      assertGeneration(footer, "—", "·");
    });
  }
});

test("dims live speed on every terminal event, including errors and aborts", async (t) => {
  for (const event of ["message_end", "turn_end", "agent_end"]) {
    await t.test(event, async (t) => {
      let now = 10_000;
      t.mock.method(Date, "now", () => now);
      const { footer, emit } = await createFooter(t);
      await emit("turn_start");
      now += 1_000;
      await emit("message_update", { assistantMessageEvent: { delta: "a".repeat(40) } });
      now += 500;
      await emit("message_update", { assistantMessageEvent: { delta: "b".repeat(40) } });
      assertGeneration(footer, "1.0s", "40", "tps");
      await emit(event, { message: { role: "assistant", stopReason: "error", usage: { output: 20 } } });
      now += 60_000;
      assertGeneration(footer, "1.0s", "40");
    });
  }
});

test("shows measured TTFT with unavailable speed for a sub-debounce response", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  now += 1_000;
  await emit("message_update", { assistantMessageEvent: { delta: "short" } });
  now += 100;
  await emit("message_end", { message: { role: "assistant", usage: { output: 1 } } });
  assertGeneration(footer, "1.0s", "·");
});

test("hides generation measurements again on session replacement or reload", async (t) => {
  for (const reason of ["new", "resume", "reload"]) {
    await t.test(reason, async (t) => {
      let now = 10_000;
      t.mock.method(Date, "now", () => now);
      const fixture = await createFooter(t);
      await fixture.emit("turn_start");
      now += 1_000;
      await fixture.emit("message_update", { assistantMessageEvent: { delta: "a".repeat(40) } });
      now += 500;
      await fixture.emit("message_update", { assistantMessageEvent: { delta: "b".repeat(40) } });
      assertGeneration(fixture.footer, "1.0s", "40", "tps");
      await fixture.emit("session_shutdown");
      await fixture.emit("session_start", { reason });
      assert.deepEqual(fixture.footer.render(minimumWidth), [desktopRow(minimumWidth)]);
    });
  }
});
