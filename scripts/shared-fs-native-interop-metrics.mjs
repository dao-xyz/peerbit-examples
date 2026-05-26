#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , command, ...args] = process.argv;

const readJson = (file) => {
	if (!fs.existsSync(file)) {
		return {
			schema: 1,
			phases: {},
			observations: [],
		};
	}
	return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
};

const writeJson = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

const formatDuration = (ms) => {
	if (typeof ms !== "number" || !Number.isFinite(ms)) {
		return "";
	}
	if (ms < 1000) {
		return `${ms} ms`;
	}
	return `${(ms / 1000).toFixed(2)} s`;
};

const renderSummary = (metricsFiles) => {
	const sections = [];

	for (const file of metricsFiles) {
		if (!fs.existsSync(file)) {
			continue;
		}
		const metrics = readJson(file);
		const title = [metrics.machine, metrics.role].filter(Boolean).join(" / ");
		sections.push(`### ${title || path.basename(file)} timing`);
		sections.push("");
		sections.push("| Metric | Time |");
		sections.push("| --- | ---: |");
		if (typeof metrics.durationMs === "number") {
			sections.push(`| total | ${formatDuration(metrics.durationMs)} |`);
		}
		for (const [phase, duration] of Object.entries(metrics.phases ?? {})) {
			sections.push(`| ${phase} | ${formatDuration(duration)} |`);
		}
		sections.push("");

		if (metrics.observations?.length) {
			sections.push("| Observation | Peer | Wait |");
			sections.push("| --- | --- | ---: |");
			for (const observation of metrics.observations) {
				sections.push(
					`| ${observation.kind} | ${observation.machine} | ${formatDuration(
						observation.waitMs,
					)} |`,
				);
			}
			sections.push("");
		}
	}

	return sections.join("\n");
};

if (command === "phase") {
	const [file, machine, role, phase, startMsRaw, endMsRaw, statusRaw = "0"] =
		args;
	if (!file || !machine || !role || !phase || !startMsRaw || !endMsRaw) {
		throw new Error(
			"usage: shared-fs-native-interop-metrics.mjs phase <file> <machine> <role> <phase> <startMs> <endMs> [status]",
		);
	}

	const startMs = Number(startMsRaw);
	const endMs = Number(endMsRaw);
	const metrics = readJson(file);
	metrics.machine = metrics.machine ?? machine;
	metrics.role = metrics.role ?? role;
	metrics.status = Number(statusRaw);
	metrics.startedAtMs =
		typeof metrics.startedAtMs === "number"
			? Math.min(metrics.startedAtMs, startMs)
			: startMs;
	metrics.endedAtMs =
		typeof metrics.endedAtMs === "number"
			? Math.max(metrics.endedAtMs, endMs)
			: endMs;
	metrics.durationMs = metrics.endedAtMs - metrics.startedAtMs;
	metrics.phases = metrics.phases ?? {};
	metrics.phases[phase] = endMs - startMs;
	writeJson(file, metrics);
} else if (command === "summary") {
	const summary = renderSummary(args);
	if (summary) {
		console.log(summary);
		if (process.env.GITHUB_STEP_SUMMARY) {
			fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
		}
	}
} else {
	throw new Error(
		"usage: shared-fs-native-interop-metrics.mjs <phase|summary> ...",
	);
}
