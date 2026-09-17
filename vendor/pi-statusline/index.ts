/**
 * Pi statusline extension — the pi counterpart of statusline.py in this directory.
 *
 * statusline.py can't be reused as-is: claude-code / copilot-cli invoke an
 * external command and pipe it a JSON payload on stdin per render, whereas pi
 * has no such hook. Instead pi exposes an in-process *custom footer*
 * (`ctx.ui.setFooter`), so the extension renders the line itself and pulls the
 * numbers from `ctx` (sessionManager / model / context usage) plus
 * `pi.getThinkingLevel()`. This file reproduces the same LOOK:
 *
 *   <starship: dir + git>   $cost  ↑all-in (󰮆 non-cache-read 󱤟 cache%) ↓out (󱐋 82.3 T/s)  ▰▰▱▱ pct% used/limit  Model  effort
 *   └────────── left ──────────┘   └───────────────────────────── right group, flex-right ─────────────────────────────┘
 *
 * When that layout does not fit, use three independently truncated rows,
 * ordered from most frequently changing to least: tokens + cost;
 * model + effort + context; Starship left.
 *
 * The parenthesised suffix on the output count reports the generation phase:
 * while a turn's first token is pending it counts the in-progress TTFT
 * ("(󱦟 1.4s)") from the same `turn_start` anchor `tps.ts` (the pinned
 * `@everyx/pi-status-line` dependency) uses; the first token swaps it to the
 * live decode rate, and the finalized message freezes that rate to the
 * provider's exact output count. Rates are cached rather than recomputed
 * against render-time `Date.now()`, so a repaint while typing cannot make a
 * frozen number drift; the wait clock is the deliberate exception, since it
 * exists to grow.
 *
 * Colours are catppuccin-mocha (teal / sapphire / overlay 1 / maroon / peach /
 * flamingo), emitted as raw 24-bit ANSI rather than mapping onto pi's semantic
 * theme names. The left side shells out to
 * `starship module …` exactly like the python, but caches the result (refreshed
 * on session start, git branch change, and turn end) since the footer
 * re-renders far more often than a one-shot CLI statusline.
 *
 * Caveat vs claude-code: cost is summed from pi's per-model `cost` config, which
 * for the Copilot-backed catalog is NOTIONAL (flat-rate subscription), so the
 * "$" figure tracks modelled spend, not a real bill.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

import { TurnMetrics } from "@everyx/pi-status-line/tps.ts";

// --- colour primitives (catppuccin-mocha, raw 24-bit ANSI) -------------------

function fg(hex: string): string {
	const h = hex.replace(/^#/, "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

const TEAL = fg("#94E2D5"); // cumulative cost
const SAPPHIRE = fg("#74C7EC"); // cumulative token usage
const OVERLAY_1 = fg("#7F849C"); // secondary token details
const MAROON = fg("#EBA0AC"); // model
const PEACH = fg("#FAB387"); // effort
const FLAMINGO = fg("#F2CDCD"); // context bar
const RESET = "\x1b[0m";

// Nerd-font progress-bar cells (Private Use Area): (left-cap, middle, right-cap),
// empty vs filled. Written as \u escapes so the source survives any encoding
// round-trip (mirrors the same note in statusline.py).
const CTX_EMPTY = ["\uee00", "\uee01", "\uee02"];
const CTX_FILLED = ["\uee03", "\uee04", "\uee05"];

// Nerd Font icons labelling the values attached to the token section:
// non-cache-read input and cache-hit rate inside the input parentheses, plus the
// prefill wait and decode rate on the output suffix. Written as escapes so the
// source survives encoding and HTML round-trips.
const NON_CACHE_READ_ICON = "\u{f0b86}";
const CACHE_HIT_ICON = "\u{f191f}";
const TTFT_ICON = "\u{f199f}";
const TPS_ICON = "\u{f140b}";

// --- number / text helpers (ports of statusline.py) --------------------------

/** Round half away from zero, like jq/C round. */
function jround(x: number): number {
	return Math.floor(x + 0.5);
}

/** Minimal number formatting, like jq %g: 2.0 -> "2", 1.2 -> "1.2". */
function num(x: number): string {
	return String(Math.round(x * 1e6) / 1e6);
}

/** Compact token count: 1234 -> "1.2k", 1_500_000 -> "1.5M". */
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${num(jround((n / 1_000_000) * 10) / 10)}M`;
	if (n >= 1_000) return `${num(jround((n / 1_000) * 10) / 10)}k`;
	return num(n);
}

/** Decode speed for the live segment: "82.3 T/s", widening to integers at 100+. */
function fmtTps(tps: number): string {
	return `${tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)} T/s`;
}

/** Prefill wait in seconds for the output suffix: "0.0s" through "10.5s". */
function fmtTtft(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Render a `width`-cell PUA progress bar filled to `pct` percent. */
function contextBar(pct: number, width = 10): string {
	const filled = jround((pct / 100) * width);
	let cells = "";
	for (let i = 0; i < width; i++) {
		const caps = i < filled ? CTX_FILLED : CTX_EMPTY;
		cells += i === 0 ? caps[0] : i === width - 1 ? caps[2] : caps[1];
	}
	return cells;
}

// --- starship left side (cached subprocess) ----------------------------------

const LEFT_MODULES = ["git_branch", "git_status", "git_metrics"];

// Resolve Starship from PATH by default. An explicit path can be supplied for
// declarative environments such as Nix, where PATH lookup is intentionally
// avoided.
const STARSHIP_BIN = process.env.PI_STATUSLINE_STARSHIP || "starship";

function starshipModule(module: string, cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			STARSHIP_BIN,
			["module", module],
			{ cwd, encoding: "utf-8", timeout: 2000 },
			(err, stdout) => resolve(err ? "" : (stdout || "").trim()),
		);
	});
}

async function renderStarshipLeft(cwd: string): Promise<string> {
	const dir = await starshipModule("directory", cwd);
	let left = dir;
	for (const mod of LEFT_MODULES) {
		const seg = await starshipModule(mod, cwd);
		if (seg) left += " " + seg;
	}
	return left;
}

// --- right side (every segment rendered unconditionally) ---------------------

interface Metrics {
	cost: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

// pi's session is an append-only TREE (forking, rewind/retry, /tree navigation
// spawn branches). getEntries() returns every entry across ALL branches in
// append order; getBranch() only walks the current leaf's root->tip path. We
// use getEntries() so abandoned branches remain in the cumulative token/cost
// accounting: their model calls still incurred usage.
//
// This matches Pi's built-in cumulative totals: assistant calls, tools that
// report nested LLM usage, and compaction/branch-summary calls all contribute.
// (The official custom-footer.ts example uses getBranch().)
function addUsage(metrics: Metrics, usage: Usage): void {
	metrics.cost += usage.cost?.total ?? 0;
	metrics.input += usage.input ?? 0;
	metrics.cacheRead += usage.cacheRead ?? 0;
	metrics.cacheWrite += usage.cacheWrite ?? 0;
	metrics.output += usage.output ?? 0;
}

function collectMetrics(entries: ReadonlyArray<SessionEntry>): Metrics {
	const metrics: Metrics = { cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				addUsage(metrics, entry.message.usage);
			} else if (entry.message.role === "toolResult" && entry.message.usage) {
				addUsage(metrics, entry.message.usage);
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addUsage(metrics, entry.usage);
		}
	}

	return metrics;
}

/**
 * Share of accumulated input tokens served from the prompt cache, or null when
 * nothing has been sent yet.
 *
 * null is omitted from the rendered token section entirely rather than filled
 * with a placeholder. A genuine 0 is kept and shown: a cold or invalidated cache
 * is a real and meaningfully different reading. This is a token-count rate, not
 * a spend rate: cache writes cost more per token than reads, so even a high hit
 * rate can leave the miss share dominating the bill.
 *
 * Cumulative, matching the claude-code / copilot-cli statusline. A per-turn
 * rate would be more sensitive to cache invalidation and is easy to get here
 * (the last assistant entry's usage), but copilot-cli's payload cannot produce
 * one -- its last_call_* fields carry no cache split -- so the three agents
 * would then be showing different metrics under the same glyph.
 */
function cacheHitRate(metrics: Metrics): number | null {
	const allInput = metrics.input + metrics.cacheRead + metrics.cacheWrite;
	if (allInput <= 0) return null;
	return Math.max(0, Math.min(1, metrics.cacheRead / allInput));
}

interface RightSegments {
	cost: string;
	tokens: string;
	context: string;
	model: string;
	effort: string;
}

function renderRightSegments(
	metrics: Metrics,
	outputSuffix: string | null,
	pct: number | null,
	contextTokens: number | null,
	limit: number,
	model: string,
	effort: string,
): RightSegments {
	const allInput = metrics.input + metrics.cacheRead + metrics.cacheWrite;
	// This excludes only cache hits. It includes normal input and cache writes,
	// both of which are more directly tied to spend than cache-read input.
	const nonCacheReadInput = metrics.input + metrics.cacheWrite;
	// ↑all-input (non-cache-read cache-hit-rate) ↓output. Icons identify the two
	// parenthesised values. When the rate is unknowable its icon and value are
	// dropped rather than filled with a placeholder.
	const hitRate = cacheHitRate(metrics);
	// One decimal, rounded jq-style through jround so this agrees with
	// statusline.py digit for digit. The trailing zero is kept -- "80.0%" not
	// "80%" -- so the segment does not change width as the rate drifts, which is
	// why num() is not used here.
	const cacheHit =
		hitRate === null
			? ""
			: ` ${CACHE_HIT_ICON} ${(jround(hitRate * 1000) / 10).toFixed(1)}%`;
	// The generation suffix rides the output count: the in-progress TTFT while
	// the first token is pending, the decode rate afterwards. Omitted until a
	// turn starts, like the cache-hit rate inside the input parentheses above.
	// Both parenthesized groups use a muted palette color so the cumulative
	// input and output totals remain the visual focus.
	const suffix = outputSuffix === null ? "" : ` ${OVERLAY_1}(${outputSuffix})${RESET}`;
	const tokens = `${SAPPHIRE}↑${fmtTokens(allInput)}${RESET} ${OVERLAY_1}(${NON_CACHE_READ_ICON} ${fmtTokens(nonCacheReadInput)}${cacheHit})${RESET} ${SAPPHIRE}↓${fmtTokens(metrics.output)}${RESET}${suffix}`;
	const context =
		pct === null || contextTokens === null
			? `?% ?/${fmtTokens(limit)}`
			: `${contextBar(pct)} ${num(Math.round(pct))}% ${fmtTokens(contextTokens)}/${fmtTokens(limit)}`;
	return {
		cost: `${TEAL}$${metrics.cost.toFixed(2)}${RESET}`,
		tokens,
		context: `${FLAMINGO}${context}${RESET}`,
		model: `${MAROON}${model}${RESET}`,
		effort: `${PEACH}${effort}${RESET}`,
	};
}

// --- extension ---------------------------------------------------------------

/**
 * Text carried by a streaming update, or null for lifecycle-only events
 * (`text_start`, `text_end`, …). Decode speed counts text, thinking, and
 * streamed tool-call arguments alike -- all of them are generated output.
 */
function streamDelta(event: { assistantMessageEvent: { delta?: unknown } }): string | null {
	const delta = event.assistantMessageEvent.delta;
	return typeof delta === "string" && delta.length > 0 ? delta : null;
}

export default function (pi: ExtensionAPI) {
	let left = "";
	let requestRender: (() => void) | undefined;

	// Live generation metrics: the pinned dependency's module owns the decode
	// clock (and the same `turn_start` anchor its TTFT uses), this file owns the
	// rendered text and the in-progress wait clock.
	const generation = new TurnMetrics();
	let turnStartedAt: number | null = null;
	let tpsText: string | null = null;
	let lastRenderRequestMs = 0;
	let waitTicker: ReturnType<typeof setInterval> | undefined;

	// collectMetrics walks every session entry, and streaming now repaints many
	// times per turn; cache the totals between appends and finalized messages.
	let cachedEntriesLength = -1;
	let cachedMetrics: Metrics | null = null;

	const metricsFor = (entries: ReadonlyArray<SessionEntry>): Metrics => {
		if (cachedMetrics === null || entries.length !== cachedEntriesLength) {
			cachedMetrics = collectMetrics(entries);
			cachedEntriesLength = entries.length;
		}
		return cachedMetrics;
	};

	const invalidateMetrics = (): void => {
		cachedMetrics = null;
		cachedEntriesLength = -1;
	};

	// Repaints happen per keystroke and per stream delta; coalesce the stream
	// nudges. Turn boundaries render unconditionally.
	const requestRenderThrottled = (now: number): void => {
		if (now - lastRenderRequestMs < 100) return;
		lastRenderRequestMs = now;
		requestRender?.();
	};

	// While a turn's first token is in flight no stream events arrive, so a
	// ticker keeps the wait clock moving. It exists only for that window, and
	// every terminal event clears it.
	const stopWaitTicker = (): void => {
		if (waitTicker === undefined) return;
		clearInterval(waitTicker);
		waitTicker = undefined;
	};

	const startWaitTicker = (): void => {
		stopWaitTicker();
		waitTicker = setInterval(() => requestRender?.(), 100);
	};

	// The output suffix reports the phase rather than a combined readout: while
	// the first token is pending it counts the in-progress TTFT, afterwards it
	// shows the decode rate. Omitted entirely before the session's first turn.
	// The wait clock is computed at render time on purpose -- being a clock, it
	// should track wall time.
	const renderGeneration = (now: number): string | null => {
		if (turnStartedAt !== null) return `${TTFT_ICON} ${fmtTtft(now - turnStartedAt)}`;
		return tpsText === null ? null : `${TPS_ICON} ${tpsText}`;
	};

	const resetGeneration = (): void => {
		stopWaitTicker();
		generation.clear();
		turnStartedAt = null;
		tpsText = null;
		invalidateMetrics();
	};

	// Recompute the cached starship left side, then nudge a re-render.
	const refreshLeft = (cwd: string) => {
		renderStarshipLeft(cwd).then((rendered) => {
			if (rendered !== left) {
				left = rendered;
				requestRender?.();
			}
		});
	};

	pi.on("turn_start", async () => {
		const now = Date.now();
		generation.startTurn(now);
		turnStartedAt = now;
		startWaitTicker();
		lastRenderRequestMs = 0;
		requestRender?.();
	});

	pi.on("message_update", async (event) => {
		const delta = streamDelta(event);
		if (delta === null) return;

		const now = Date.now();
		generation.addDelta(delta, now);

		// The first delta ends the wait phase: the slot hands over from the TTFT
		// clock to the decode rate.
		turnStartedAt = null;
		stopWaitTicker();

		// A null rate (inside the module's 250ms debounce) keeps the previous
		// text rather than collapsing the segment to a placeholder.
		const tps = generation.liveTps(now);
		if (tps !== null) tpsText = fmtTps(tps);
		requestRenderThrottled(now);
	});

	pi.on("message_end", async (event) => {
		invalidateMetrics();
		// A finalized assistant message can carry the provider's exact output
		// count; the module prefers it over the chars estimate when present.
		if (event.message.role === "assistant") {
			turnStartedAt = null;
			stopWaitTicker();
			const tps = generation.averageTps(Date.now(), event.message.usage?.output);
			if (tps !== null) tpsText = fmtTps(tps);
		}
		requestRender?.();
	});

	// Esc or a failed request can end a run while the first token is still
	// pending; the wait ticker must not outlive its turn.
	pi.on("agent_end", async () => {
		turnStartedAt = null;
		stopWaitTicker();
		requestRender?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		resetGeneration();
		refreshLeft(ctx.cwd);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				invalidateMetrics();
				refreshLeft(ctx.cwd);
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const metrics = metricsFor(ctx.sessionManager.getEntries());
					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? null;
					const contextTokens = usage?.tokens ?? null;
					const limit = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const model = ctx.model?.name || ctx.model?.id || "";
					const effort = pi.getThinkingLevel();

					const segments = renderRightSegments(
						metrics,
						renderGeneration(Date.now()),
						pct,
						contextTokens,
						limit,
						model,
						effort,
					);
					const right = [segments.cost, segments.tokens, segments.context, segments.model, segments.effort].join(" ");
					const gap = width - visibleWidth(left) - visibleWidth(right);
					if (gap >= 1) {
						return [truncateToWidth(left + " ".repeat(gap) + right, width)];
					}
					return [
						`${segments.tokens} ${segments.cost}`,
						`${segments.model} ${segments.effort} ${segments.context}`,
						left,
					].map((line) => truncateToWidth(line, width));
				},
			};
		});
	});

	// Working-tree state (git_status / git_metrics) drifts as the agent edits
	// files; refresh after each turn so the cached left side stays honest.
	pi.on("turn_end", async (_event, ctx) => {
		turnStartedAt = null;
		stopWaitTicker();
		invalidateMetrics();
		requestRender?.();
		refreshLeft(ctx.cwd);
	});

	pi.on("session_shutdown", async () => resetGeneration());
}
