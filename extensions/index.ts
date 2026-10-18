/**
 * tmux-subagent (orchestrator side)
 *
 * Registers the `subagent_tmux` tool. It spawns an interactive pi subagent
 * in a new tmux window (or detached tmux session when not running inside tmux).
 * A human can watch and interact with the subagent live. When the subagent
 * calls `subagent_done` (provided by the companion done.ts extension), its
 * report is written to result.json, its pi process shuts down, and the tmux
 * window closes. The report is then returned to the orchestrator as the
 * tool result.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DONE_EXT = path.join(EXT_DIR, "done.ts");
const JOBS_DIR = path.join(os.tmpdir(), "pi-tmux-subagent");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const INSTRUCTIONS = `You are a pi subagent spawned by an orchestrator session to complete one task.

Rules:
- The task is in the file given in your first message. Read it and do the work in the current directory.
- A human can see your tmux window in real time and may send you messages. Incorporate anything they send.
- Use your tools normally (read, edit, bash, ...).
- When the task is complete, or if you are blocked, call the subagent_done tool with a concise final report
  (what you did, key file paths, test results, anything the orchestrator must know).
  Calling subagent_done is the ONLY way to deliver your result; it closes your session.
- Do NOT finish your turn without calling subagent_done when the work is done.`;

const Params = Type.Object({
	task: Type.String({ description: "The task for the subagent. Be specific and self-contained." }),
	title: Type.Optional(Type.String({ description: "Short label for the tmux window (default: task prefix)." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Default: orchestrator cwd." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent (provider/modelId). Default: inherit." })),
	timeout_ms: Type.Optional(Type.Number({ description: `Max wait time in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
});

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const r = spawnSync("tmux", args, { encoding: "utf-8" });
	return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

interface Target {
	kind: "window" | "session";
	name: string;
}

function alive(target: Target): boolean {
	if (target.kind === "session") return tmux(["has-session", "-t", target.name]).ok;
	// tmux has no `has-window`; list all windows and check for the id.
	const r = tmux(["list-windows", "-a", "-F", "#{window_id}"]);
	return r.ok && r.stdout.split("\n").includes(target.name);
}

function killTarget(target: Target): void {
	tmux(target.kind === "window" ? ["kill-window", "-t", target.name] : ["kill-session", "-t", target.name]);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_tmux",
		label: "Tmux Subagent",
		description:
			"Spawn an interactive pi subagent in a tmux window so the human can watch and interact live. " +
			"Blocks until the subagent calls subagent_done; returns its final report. " +
			"Give self-contained tasks; the subagent has no memory of this conversation.",
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const id = crypto.randomBytes(4).toString("hex");
			const title = (params.title || params.task).slice(0, 30).replace(/[^\w .-]+/g, "_").trim() || "task";
			const jobDir = path.join(JOBS_DIR, id);
			fs.mkdirSync(jobDir, { recursive: true });
			const taskPath = path.join(jobDir, "task.md");
			const resultPath = path.join(jobDir, "result.json");
			const instructionsPath = path.join(jobDir, "instructions.md");
			const scriptPath = path.join(jobDir, "run.sh");
			const sessionPath = path.join(jobDir, "session.jsonl");

			fs.writeFileSync(taskPath, params.task, "utf-8");
			fs.writeFileSync(instructionsPath, INSTRUCTIONS, "utf-8");

			const cwd = params.cwd ?? ctx.cwd;
			const modelArgs = params.model ? `--model ${shellQuote(params.model)} ` : "";
			const winName = `subagent-${id}`;
			const sessName = `pi-sub-${id}`;

			fs.writeFileSync(
				scriptPath,
				`#!/usr/bin/env bash
cd ${shellQuote(cwd)} || exit 1
PI_SUBAGENT_RESULT=${shellQuote(resultPath)} pi \\
  --session ${shellQuote(sessionPath)} \\
  --append-system-prompt ${shellQuote(instructionsPath)} \\
  -e ${shellQuote(DONE_EXT)} \\
  ${modelArgs}${shellQuote(`Read ${taskPath} and complete the task. When finished, call subagent_done with your final report.`)} 2>> ${shellQuote(path.join(jobDir, "pi.log"))}
status=$?
if [ -f ${shellQuote(resultPath)} ]; then
  tmux kill-window -t "${winName}" 2>/dev/null
  tmux kill-session -t "${sessName}" 2>/dev/null
  exit 0
fi
echo ""
echo "subagent exited (status $status) without calling subagent_done."
echo "Session saved to ${sessionPath}. Press enter to close this window."
read -r _
`,
				{ mode: 0o755 },
			);

			// Spawn the tmux window (inside tmux) or a detached session (outside tmux).
			let target: Target;
			let how: string;
			if (process.env.TMUX) {
				const r = tmux(["new-window", "-P", "-F", "#{window_id}", "-n", winName, scriptPath]);
				if (!r.ok) return { content: [{ type: "text", text: `tmux new-window failed: ${r.stderr}` }], details: {}, isError: true };
				target = { kind: "window", name: r.stdout };
				how = `tmux window "${winName}" (Ctrl-b n / p to switch to it)`;
			} else {
				const r = tmux(["new-session", "-d", "-s", sessName, "-n", winName, scriptPath]);
				if (!r.ok) return { content: [{ type: "text", text: `tmux new-session failed: ${r.stderr}` }], details: {}, isError: true };
				target = { kind: "session", name: sessName };
				how = `detached tmux session "${sessName}" — watch with: tmux attach -t ${sessName}`;
			}

			onUpdate?.({ content: [{ type: "text", text: `Subagent running in ${how}. Waiting for report...` }], details: { id, jobDir, target } });

			// Wait for the report, window death, abort, or timeout.
			const logPath = path.join(jobDir, "orchestrator.log");
			const log = (msg: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`, "utf-8");
			log(`spawned: ${how}; target=${target.kind}:${target.name}`);
			const deadline = Date.now() + (params.timeout_ms ?? DEFAULT_TIMEOUT_MS);
			let deadCount = 0;
			for (;;) {
				if (fs.existsSync(resultPath)) {
					let report = "";
					try {
						report = JSON.parse(fs.readFileSync(resultPath, "utf-8")).report ?? "";
					} catch {
						report = fs.readFileSync(resultPath, "utf-8");
					}
					// The window closes itself; make sure it's gone.
					await sleep(300);
					if (alive(target)) killTarget(target);
					return {
						content: [{ type: "text", text: report || "(empty report)" }],
						details: { id, jobDir, sessionPath, status: "done" },
					};
				}
				if (signal?.aborted) {
					log("aborted by signal");
					killTarget(target);
					return { content: [{ type: "text", text: "Subagent aborted by orchestrator." }], details: { id, status: "aborted" }, isError: true };
				}
				if (alive(target)) {
					deadCount = 0;
				} else if (++deadCount >= 3) {
					log("target reported dead after 3 checks");
					return {
						content: [{ type: "text", text: `Subagent exited without a report. Transcript: ${sessionPath}` }],
						details: { id, jobDir, sessionPath, status: "no_report" },
						isError: true,
					};
				}
				if (Date.now() > deadline) {
					killTarget(target);
					return { content: [{ type: "text", text: `Subagent timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms.` }], details: { id, status: "timeout" }, isError: true };
				}
				await sleep(1000, signal);
			}
		},
	});
}
