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
 *   <starship: dir + git>            $cost  ↑all-in (󰮆 non-cache-read 󱤟 cache%) ↓out  ▰▰▱▱ pct% used/limit  Model  effort
 *   └────────── left ──────────┘     └─────────────────── right group, flex-right ─────────┘
 *
 * Colours are catppuccin-mocha (teal / maroon / flamingo), emitted as raw
 * 24-bit ANSI so they match statusline.py exactly rather than mapping onto pi's
 * semantic theme names. The left side shells out to `starship module …` exactly
 * like the python, but caches the result (refreshed on session start, git
 * branch change, and turn end) since the footer re-renders far more often than a
 * one-shot CLI statusline.
 *
 * Caveat vs claude-code: cost is summed from pi's per-model `cost` config, which
 * for the Copilot-backed catalog is NOTIONAL (flat-rate subscription), so the
 * "$" figure tracks modelled spend, not a real bill.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

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
const MAROON = fg("#EBA0AC"); // context bar
const FLAMINGO = fg("#F2CDCD"); // model + effort
const RESET = "\x1b[0m";

// Nerd-font progress-bar cells (Private Use Area): (left-cap, middle, right-cap),
// empty vs filled. Written as \u escapes so the source survives any encoding
// round-trip (mirrors the same note in statusline.py).
const CTX_EMPTY = ["\uee00", "\uee01", "\uee02"];
const CTX_FILLED = ["\uee03", "\uee04", "\uee05"];

// Nerd Font icons labelling the non-cache-read input and cache hit rate inside
// the token section's parentheses. Written as escapes so the source survives
// encoding and HTML round-trips.
const NON_CACHE_READ_ICON = "\u{f0b86}";
const CACHE_HIT_ICON = "\u{f191f}";

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

function renderRight(
	metrics: Metrics,
	pct: number | null,
	contextTokens: number | null,
	limit: number,
	model: string,
	effort: string,
): string {
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
	const tokens = `${SAPPHIRE}↑${fmtTokens(allInput)} (${NON_CACHE_READ_ICON} ${fmtTokens(nonCacheReadInput)}${cacheHit}) ↓${fmtTokens(metrics.output)}${RESET}`;
	const context =
		pct === null || contextTokens === null
			? `?% ?/${fmtTokens(limit)}`
			: `${contextBar(pct)} ${num(Math.round(pct))}% ${fmtTokens(contextTokens)}/${fmtTokens(limit)}`;
	const segs = [
		`${TEAL}$${metrics.cost.toFixed(2)}${RESET}`,
		tokens,
		`${MAROON}${context}${RESET}`,
		`${FLAMINGO}${model}${RESET}`,
		`${FLAMINGO}${effort}${RESET}`,
	];
	return segs.join(" ");
}

// --- extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let left = "";
	let requestRender: (() => void) | undefined;

	// Recompute the cached starship left side, then nudge a re-render.
	const refreshLeft = (cwd: string) => {
		renderStarshipLeft(cwd).then((rendered) => {
			if (rendered !== left) {
				left = rendered;
				requestRender?.();
			}
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshLeft(ctx.cwd);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				refreshLeft(ctx.cwd);
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const metrics = collectMetrics(ctx.sessionManager.getEntries());
					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? null;
					const contextTokens = usage?.tokens ?? null;
					const limit = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const model = ctx.model?.name || ctx.model?.id || "";
					const effort = pi.getThinkingLevel();

					const right = renderRight(metrics, pct, contextTokens, limit, model, effort);
					const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					return [truncateToWidth(left + " ".repeat(gap) + right, width)];
				},
			};
		});
	});

	// Working-tree state (git_status / git_metrics) drifts as the agent edits
	// files; refresh after each turn so the cached left side stays honest.
	pi.on("turn_end", async (_event, ctx) => refreshLeft(ctx.cwd));
}
