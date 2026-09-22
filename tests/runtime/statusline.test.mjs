import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getPiRuntime } from "../helpers/pi-runtime.mjs";

// Use Pi's independently locked loader, theme helper, and ANSI/column-width utilities.
const runtime = getPiRuntime();
const { createJiti } = await import(pathToFileURL(runtime.resolve("jiti")));
const tui = await import(pathToFileURL(runtime.resolve("@earendil-works/pi-tui")));
const { truncateToWidth, visibleWidth } = tui;
const piTheme = await import(new URL("../modes/interactive/theme/theme.js", pathToFileURL(runtime.cli)));
const defaultTheme = piTheme.loadThemeFromPath(fileURLToPath(new URL(
  "../../node_modules/@sherif-fanous/pi-catppuccin/themes/catppuccin-mocha.json", import.meta.url,
)), "truecolor");
const alternateTheme = piTheme.loadThemeFromPath(fileURLToPath(new URL(
  "../modes/interactive/theme/dark.json", pathToFileURL(runtime.cli),
)), "truecolor");
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
  model: color("250;179;135", "Test Model"),
  effort: defaultTheme.getThinkingBorderColor("high")("high"),
};
const right = [segments.cost, segments.tokens, segments.context, segments.model, segments.effort].join(" ");
const minimumWidth = visibleWidth(left) + 5 + visibleWidth(right);
const compactTokens = [color("116;199;236", "↑10k"), color("116;199;236", "↓300")].join(" ");
const compactRight = [segments.cost, compactTokens, segments.context, segments.model, segments.effort].join(" ");
const compactMinimumWidth = visibleWidth(left) + 1 + visibleWidth(compactRight);
const mobileRows = [
  `${segments.tokens} ${segments.cost}`,
  `${segments.model} ${segments.effort} ${segments.context}`,
  left,
];
const compactMobileRows = [`${compactTokens} ${segments.cost}`, mobileRows[1], left];

async function createFooter(t, { entries, reason = "startup", thinkingLevel = "high", starshipModules = starship } = {}) {
  piTheme.setThemeInstance(defaultTheme);
  t.after(() => piTheme.setThemeInstance(defaultTheme));
  const execFile = t.mock.method(childProcess, "execFile", (_command, args, _options, callback) => {
    queueMicrotask(() => callback(null, starshipModules[args[1]] ?? ""));
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
  let resolveLeftReady;
  const leftReady = new Promise((resolve) => { resolveLeftReady = resolve; });
  const requestRender = t.mock.fn(() => resolveLeftReady());
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
        footer = factory({ requestRender }, piTheme.theme, { onBranchChange: () => () => {} });
      },
    },
  };
  extension({
    on: (event, handler) => handlers.set(event, handler),
    getThinkingLevel: () => thinkingLevel,
  });
  const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
  t.after(async () => {
    await emit("session_shutdown");
    footer?.dispose();
  });
  await emit("session_start", { reason });
  await leftReady;
  return {
    get footer() { return footer; }, ctx, emit, requestRender,
    async setThinkingLevel(level) {
      const previousLevel = thinkingLevel;
      thinkingLevel = level;
      await emit("thinking_level_select", { level, previousLevel });
    },
  };
}

function desktopRow(width, renderedRight = right, renderedLeft = left) {
  return truncateToWidth(renderedLeft + " ".repeat(width - visibleWidth(renderedLeft) - visibleWidth(renderedRight)) + renderedRight, width);
}

test("renders the single-line text, colors, order, and right alignment", async (t) => {
  const { footer } = await createFooter(t);
  const width = minimumWidth + 30;
  assert.deepEqual(footer.render(width), [desktopRow(width)]);
  assert.equal(visibleWidth(footer.render(width)[0]), width);
});

function assertEffort(footer, effort) {
  const expectedRight = [segments.cost, segments.tokens, segments.context, segments.model, effort].join(" ");
  const width = visibleWidth(left) + 5 + visibleWidth(expectedRight);
  const expectedCompactRight = [segments.cost, compactTokens, segments.context, segments.model, effort].join(" ");
  const compactWidth = visibleWidth(left) + 1 + visibleWidth(expectedCompactRight);
  assert.deepEqual(footer.render(width), [desktopRow(width, expectedRight)]);
  assert.deepEqual(footer.render(width - 1), [desktopRow(width - 1, expectedCompactRight)]);
  assert.deepEqual(footer.render(compactWidth), [desktopRow(compactWidth, expectedCompactRight)]);
  assert.deepEqual(footer.render(compactWidth - 1), [
    mobileRows[0], `${segments.model} ${effort} ${segments.context}`, left,
  ]);
}

test("uses Pi's thinking-level colors and requests an immediate repaint for effort changes", async (t) => {
  const { footer, setThinkingLevel, requestRender } = await createFooter(t);
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "off"]) {
    const rendersBefore = requestRender.mock.callCount();
    await setThinkingLevel(level);
    assert.equal(requestRender.mock.callCount(), rendersBefore + 1);
    assertEffort(footer, defaultTheme.getThinkingBorderColor(level)(level));
  }
});

test("follows the active theme without recreating the footer, including Pi's max fallback", async (t) => {
  const { footer, setThinkingLevel } = await createFooter(t);
  for (const level of ["high", "max"]) {
    await setThinkingLevel(level);
    const originalEffort = defaultTheme.getThinkingBorderColor(level)(level);
    const alternateEffort = alternateTheme.getThinkingBorderColor(level)(level);
    assert.notEqual(originalEffort, alternateEffort);
    assertEffort(footer, originalEffort);

    piTheme.setThemeInstance(alternateTheme);
    footer.invalidate();
    assertEffort(footer, alternateEffort);

    piTheme.setThemeInstance(defaultTheme);
    footer.invalidate();
    assertEffort(footer, originalEffort);
  }
  // Mocha omits thinkingMax; Pi owns its fallback to thinkingXhigh.
  assert.equal(defaultTheme.getThinkingBorderColor("max")("max"), defaultTheme.fg("thinkingXhigh", "max"));
  assert.notEqual(alternateTheme.fg("thinkingMax", "max"), alternateTheme.fg("thinkingXhigh", "max"));
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
        const compact = [color("116;199;236", fixture.input), color("116;199;236", fixture.output)].join(" ");
        const expectedCompactRight = [cost, compact, segments.context, segments.model, segments.effort].join(" ");
        const width = visibleWidth(left) + 5 + visibleWidth(expectedRight);
        const compactWidth = visibleWidth(left) + 1 + visibleWidth(expectedCompactRight);
        assert.deepEqual(footer.render(width), [desktopRow(width, expectedRight)]);
        assert.deepEqual(footer.render(width - 1), [desktopRow(width - 1, expectedCompactRight)]);
        assert.deepEqual(footer.render(compactWidth), [desktopRow(compactWidth, expectedCompactRight)]);
        assert.deepEqual(footer.render(compactWidth - 1), [`${tokens} ${cost}`, mobileRows[1], left]);
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

test("reserves four extra columns for the full row but only one gap column for the compact row", async (t) => {
  const { footer } = await createFooter(t);
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
  for (let width = compactMinimumWidth; width < minimumWidth; width++) {
    assert.deepEqual(footer.render(width), [desktopRow(width, compactRight)], `compact at ${width} columns`);
    assert.equal(visibleWidth(footer.render(width)[0]), width);
  }
  assert.deepEqual(footer.render(compactMinimumWidth - 1), mobileRows);
});

test("preserves parentheses outside the token section in compact mode", async (t) => {
  const starshipModules = { ...starship, directory: color("137;180;250", "~/项目/(scratch)/😀") };
  const customLeft = Object.values(starshipModules).join(" ");
  const { footer, ctx } = await createFooter(t, { starshipModules });
  ctx.model.name = "Test Model (preview)";
  const expectedRight = [
    segments.cost, compactTokens, segments.context, color("250;179;135", ctx.model.name), segments.effort,
  ].join(" ");
  const width = visibleWidth(customLeft) + 1 + visibleWidth(expectedRight);
  assert.deepEqual(footer.render(width), [desktopRow(width, expectedRight, customLeft)]);
});

test("orders mobile rows by component update frequency", async (t) => {
  const { footer } = await createFooter(t);
  const width = Math.max(...mobileRows.map(visibleWidth));
  assert.ok(width < minimumWidth);
  assert.deepEqual(footer.render(width), mobileRows);
});

test("compacts the token + cost row only when its full contents overflow", async (t) => {
  const { footer } = await createFooter(t);
  const fullWidth = visibleWidth(mobileRows[0]);
  const compactWidth = visibleWidth(compactMobileRows[0]);
  assert.deepEqual(footer.render(fullWidth), mobileRows.map((row) => truncateToWidth(row, fullWidth)));
  for (const width of [fullWidth - 1, compactWidth + 1, compactWidth]) {
    assert.deepEqual(footer.render(width), compactMobileRows.map((row) => truncateToWidth(row, width)));
    assert.equal(footer.render(width)[0], compactMobileRows[0], "preserves complete token totals and cost");
  }
  assert.deepEqual(footer.render(compactWidth - 1), compactMobileRows.map((row) => truncateToWidth(row, compactWidth - 1)));
});

test("truncates each row independently without wrapping or exceeding the width", async (t) => {
  const { footer } = await createFooter(t);
  for (const width of [0, 1, 2, 10, 20, 40]) {
    const rows = footer.render(width);
    const expected = width >= visibleWidth(mobileRows[0]) ? mobileRows : compactMobileRows;
    assert.deepEqual(rows, expected.map((row) => truncateToWidth(row, width)));
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `row exceeds ${width} columns`);
      assert.equal(row.includes("\n"), false);
    }
  }
});

test("recalculates layout when resizing in either direction without invalidation", async (t) => {
  const { footer } = await createFooter(t);
  for (const width of [minimumWidth + 20, minimumWidth - 1, compactMinimumWidth, compactMinimumWidth - 1, 20, compactMinimumWidth, minimumWidth, minimumWidth + 40]) {
    const expectedMobileRows = width >= visibleWidth(mobileRows[0]) ? mobileRows : compactMobileRows;
    assert.deepEqual(
      footer.render(width),
      width >= minimumWidth
        ? [desktopRow(width)]
        : width >= compactMinimumWidth
          ? [desktopRow(width, compactRight)]
          : expectedMobileRows.map((row) => truncateToWidth(row, width)),
    );
  }
});

test("recalculates the fit when content changes at a fixed terminal width", async (t) => {
  const { footer, ctx } = await createFooter(t);
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
  ctx.model.name += " Extended";
  const expectedRight = [
    segments.cost, compactTokens, segments.context, color("250;179;135", ctx.model.name), segments.effort,
  ].join(" ");
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth, expectedRight)]);
  ctx.model.name += " Extended".repeat(4);
  const rows = footer.render(minimumWidth);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], mobileRows[0], "restores token details when the full token + cost row fits");
  assert.equal(rows[1], `${color("250;179;135", ctx.model.name)} ${segments.effort} ${segments.context}`);
  ctx.model.name = "Test Model";
  assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
});

test("keeps both token detail groups when they fit and drops both before truncation", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const { footer, emit } = await createFooter(t);
  await emit("turn_start");
  now += 1_500;
  const checkLayout = (suffix) => {
    const tokens = `${segments.tokens} ${suffix}`;
    const rows = [`${tokens} ${segments.cost}`, mobileRows[1], left];
    const combinedRight = [segments.cost, tokens, segments.context, segments.model, segments.effort].join(" ");
    const combinedWidth = visibleWidth(left) + 5 + visibleWidth(combinedRight);
    for (let width = 0; width <= combinedWidth + 1; width++) {
      const expectedMobileRows = width >= visibleWidth(rows[0]) ? rows : compactMobileRows;
      const expected = width >= combinedWidth
        ? [desktopRow(width, combinedRight)]
        : width >= compactMinimumWidth
          ? [desktopRow(width, compactRight)]
          : expectedMobileRows.map((row) => truncateToWidth(row, width));
      const actual = footer.render(width);
      assert.deepEqual(actual, expected, `layout at ${width} columns`);
      assert.ok(actual.every((row) => visibleWidth(row) <= width && !row.includes("\n")));
    }
  };
  checkLayout(generationSuffix("1.5s", "·", "ttft"));
  await emit("message_update", { assistantMessageEvent: { delta: "a".repeat(40) } });
  now += 500;
  await emit("message_update", { assistantMessageEvent: { delta: "b".repeat(40) } });
  checkLayout(generationSuffix("1.5s", "40", "tps"));
  await emit("message_end", { message: { role: "assistant", usage: { output: 300 } } });
  checkLayout(generationSuffix("1.5s", "600"));
});

test("compacts generation details even when there are no input details", async (t) => {
  t.mock.method(Date, "now", () => 10_000);
  const { footer, emit } = await createFooter(t, { entries: [] });
  await emit("turn_start");
  const counts = [color("116;199;236", "↑0"), color("116;199;236", "↓0")].join(" ");
  const tokens = `${counts} ${generationSuffix("0.0s", "·", "ttft")}`;
  const cost = color("148;226;213", "$0.00");
  const expectedRight = [cost, tokens, segments.context, segments.model, segments.effort].join(" ");
  const width = visibleWidth(left) + 5 + visibleWidth(expectedRight);
  const expectedCompactRight = [cost, counts, segments.context, segments.model, segments.effort].join(" ");
  assert.deepEqual(footer.render(width), [desktopRow(width, expectedRight)]);
  assert.deepEqual(footer.render(width - 1), [desktopRow(width - 1, expectedCompactRight)]);
  const tokenRow = `${tokens} ${cost}`;
  assert.equal(footer.render(visibleWidth(tokenRow))[0], tokenRow);
  assert.equal(footer.render(visibleWidth(tokenRow) - 1)[0], `${counts} ${cost}`);
});

function generationSuffix(ttft, tps, active = null) {
  const highlight = (text) => `\x1b[38;2;249;226;175m${text}\x1b[38;2;127;132;156m`;
  const ttftText = `\u{f199f} ${ttft}`;
  const tpsText = `\u{f04c5} ${tps}T/s`;
  return color("127;132;156", `(${active === "ttft" ? highlight(ttftText) : ttftText} ${active === "tps" ? highlight(tpsText) : tpsText})`);
}

function assertGeneration(footer, ttft, tps, active = null) {
  assert.ok(footer.render(250)[0].includes(`${segments.tokens} ${generationSuffix(ttft, tps, active)}`));
}

test("repaints the pending wait until each terminal event, ignoring unrelated messages", async (t) => {
  for (const event of ["message_end", "turn_end", "agent_end", "session_shutdown"]) {
    await t.test(event, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
      const { footer, emit, requestRender } = await createFooter(t);
      await emit("turn_start");
      const rendersBeforeTick = requestRender.mock.callCount();
      t.mock.timers.tick(100);
      assert.equal(requestRender.mock.callCount(), rendersBeforeTick + 1);
      assertGeneration(footer, "0.1s", "·", "ttft");

      await emit("message_end", { message: { role: "toolResult" } });
      const rendersAfterTool = requestRender.mock.callCount();
      t.mock.timers.tick(100);
      assert.equal(requestRender.mock.callCount(), rendersAfterTool + 1);
      assertGeneration(footer, "0.2s", "·", "ttft");

      await emit(event, { message: { role: "assistant", stopReason: "error", usage: { output: 0 } } });
      const rendersAfterEnd = requestRender.mock.callCount();
      t.mock.timers.tick(1_000);
      assert.equal(requestRender.mock.callCount(), rendersAfterEnd, "terminal events cancel pending wait repaints");
      if (event === "session_shutdown") {
        assert.deepEqual(footer.render(minimumWidth), [desktopRow(minimumWidth)]);
      } else {
        assertGeneration(footer, "—", "·");
      }
    });
  }
});

test("keeps only one wait ticker and stops it on the first content delta", async (t) => {
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    await t.test(type, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
      const { footer, emit, requestRender } = await createFooter(t);
      await emit("turn_start");
      await emit("turn_start");
      await emit("message_update", { assistantMessageEvent: { type: "text_start" } });
      await emit("message_update", { assistantMessageEvent: { type, delta: "" } });
      const rendersBeforeTick = requestRender.mock.callCount();
      t.mock.timers.tick(100);
      assert.equal(requestRender.mock.callCount(), rendersBeforeTick + 1, "restarting replaces the previous ticker");
      assertGeneration(footer, "0.1s", "·", "ttft");

      await emit("message_update", { assistantMessageEvent: { type, delta: "first token" } });
      const rendersAfterDelta = requestRender.mock.callCount();
      t.mock.timers.tick(1_000);
      assert.equal(requestRender.mock.callCount(), rendersAfterDelta, "content stops pending wait repaints");
      assertGeneration(footer, "0.1s", "·");
    });
  }
});

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
