/**
 * Desktop-visible usage reports.
 * Stock /usage and /grok-usage only ctx.ui.notify — Desktop toasts are 1 line, 60px.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveOAuthCredential } from "../npm/node_modules/pi-grok-usage/extensions/auth.ts";
import { fetchUsage, renderUsage } from "../npm/node_modules/pi-grok-usage/extensions/usage.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

async function show(ctx: ExtensionCommandContext, title: string, body: string) {
	const text = body.trim() || "(empty)";
	if (typeof ctx.ui.editor === "function") {
		await ctx.ui.editor(title, text);
		return;
	}
	if (typeof ctx.ui.confirm === "function") {
		await ctx.ui.confirm(title, text);
		return;
	}
	ctx.ui.setEditorText?.(text);
	ctx.ui.notify?.(text, "info");
}

function asError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function grokReport(ctx: ExtensionCommandContext): Promise<string> {
	const credential = await resolveOAuthCredential(ctx);
	if (!credential) {
		return "No xAI OAuth token. Run /login xai, or check SuperGrok login.";
	}
	const usage = await fetchUsage(credential, ctx.signal);
	return renderUsage(usage);
}

async function codexHeaders(ctx: ExtensionCommandContext): Promise<Record<string, string> | undefined> {
	const registry = ctx.modelRegistry;
	if (!registry?.getAvailable || !registry.getApiKeyAndHeaders) return undefined;
	const models = registry.getAvailable().filter((m: { provider?: string }) => m.provider === "openai-codex");
	const ordered = [
		...(ctx.model?.provider === "openai-codex" ? [ctx.model] : []),
		...models,
	];
	for (const model of ordered) {
		try {
			const resolved = await registry.getApiKeyAndHeaders(model);
			if (!resolved?.ok && resolved?.auth === undefined && !resolved?.apiKey) continue;
			const headers = { ...(resolved.headers ?? {}) };
			const apiKey = resolved.apiKey ?? resolved.auth?.apiKey;
			if (!headers.Authorization && apiKey) headers.Authorization = `Bearer ${apiKey}`;
			if (headers.Authorization) {
				if (!headers.Accept) headers.Accept = "application/json";
				return headers;
			}
		} catch {
			// try next model
		}
	}
	return undefined;
}

async function usageReport(ctx: ExtensionCommandContext): Promise<string> {
	const headers = await codexHeaders(ctx);
	if (!headers) {
		return "No Codex login in this Pi. /login openai-codex, or stay on Grok and use /grok-usage.";
	}
	const response = await fetch(CODEX_USAGE_URL, { headers, signal: ctx.signal });
	const body = await response.text();
	if (!response.ok) {
		return `Codex usage HTTP ${response.status} ${response.statusText}\n${body.slice(0, 400)}`;
	}
	let data: any;
	try {
		data = JSON.parse(body);
	} catch {
		return `Codex usage returned non-JSON:\n${body.slice(0, 400)}`;
	}
	const lines = ["Codex usage:"];
	const plan = data.plan_type ?? data.planType;
	if (plan) lines.push(`Plan: ${plan}`);
	const limit = data.rate_limit ?? data.rateLimit;
	const windows = [
		["primary", limit?.primary_window ?? limit?.primary],
		["secondary", limit?.secondary_window ?? limit?.secondary],
	];
	for (const [name, win] of windows) {
		if (!win || typeof win !== "object") continue;
		const used = win.used_percent ?? win.usedPercent;
		const reset = win.reset_at ?? win.resetsAt;
		lines.push(
			`${name}: ${used !== undefined ? `${used}% used` : "n/a"}` +
				(reset ? ` (reset ${reset})` : ""),
		);
	}
	if (lines.length === 1) lines.push(JSON.stringify(data, null, 2).slice(0, 1500));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("grok-usage-desk", {
		description: "Show xAI SuperGrok usage in a Desktop dialog",
		handler: async (_args, ctx) => {
			try {
				await show(ctx, "Grok usage", await grokReport(ctx));
			} catch (error) {
				await show(ctx, "Grok usage", asError(error));
			}
		},
	});

	pi.registerCommand("usage-desk", {
		description: "Show Codex usage in a Desktop dialog",
		handler: async (_args, ctx) => {
			try {
				await show(ctx, "Codex usage", await usageReport(ctx));
			} catch (error) {
				await show(ctx, "Codex usage", asError(error));
			}
		},
	});
}
