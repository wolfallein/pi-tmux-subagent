/**
 * tmux-subagent (worker side)
 *
 * Loaded into the subagent's pi process via `-e` from the runner script.
 * Registers `subagent_done`: writes the report to $PI_SUBAGENT_RESULT and
 * requests a graceful shutdown. When pi exits, the runner script closes the
 * tmux window and the orchestrator picks up the report.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Params = Type.Object({
	report: Type.String({
		description: "Final report for the orchestrator: what you did, key file paths, test results, open issues.",
	}),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description:
			"Deliver your final report to the orchestrator and close this session. " +
			"Call this exactly once, when the task is complete or you are blocked. The report is all the orchestrator sees.",
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resultPath = process.env.PI_SUBAGENT_RESULT;
			if (!resultPath) {
				return { content: [{ type: "text", text: "subagent_done: PI_SUBAGENT_RESULT is not set; nothing delivered." }], details: {}, isError: true };
			}
			fs.writeFileSync(
				resultPath,
				JSON.stringify({ report: params.report, at: new Date().toISOString() }, null, 2),
				"utf-8",
			);
			// Graceful shutdown: deferred until the agent is idle, so this tool
			// result and the model's closing remark are delivered first.
			ctx.shutdown();
			return { content: [{ type: "text", text: "Report delivered to orchestrator. This session is closing." }], details: {} };
		},
	});
}
