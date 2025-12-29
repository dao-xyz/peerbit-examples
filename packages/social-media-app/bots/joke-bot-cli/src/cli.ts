import { Peerbit } from "peerbit";
import os from "os";
import path from "path";
import fs from "fs";
import select from "@inquirer/select";
import input from "@inquirer/input";
import events from "events";
import { JokeBot } from "@giga-app/joke-bot";
import { BOOTSTRAP_ADDRS, type BootstrapMode } from "@giga-app/network";

events.setMaxListeners(100);

type CliArgs = {
    directory: string;
    network: BootstrapMode;
    replicate: boolean;
    intervalMs?: number;
    intervalMinutes?: number;
    runOnStart: boolean;
    runOnce: boolean;
    dryRun: boolean;
    prefix?: string;
    scopeAddress?: string;
    parentCanvasId?: string;
};

const getFlag = (name: string) => process.argv.includes(name);
const getValue = (name: string) => {
    const idx = process.argv.indexOf(name);
    return idx === -1 ? undefined : process.argv[idx + 1];
};

const parseNumber = (value: string | undefined): number | undefined => {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};

const parseNetwork = (): BootstrapMode => {
    const explicit = (getValue("--network") ?? getValue("--net"))
        ?.trim()
        .toLowerCase();
    if (explicit === "local") return "local";
    if (explicit === "offline") return "offline";
    if (explicit === "prod" || explicit === "production") return "prod";

    if (getFlag("--offline")) return "offline";
    if (getFlag("--local")) return "local";
    if (getFlag("--prod")) return "prod";
    return "prod";
};

const parseArgs = (): CliArgs => {
    const directory =
        getValue("--directory") ??
        getValue("--dir") ??
        path.join(os.homedir(), "peerbit-giga-bots", "joke-bot");

    const intervalMs = parseNumber(getValue("--intervalMs"));
    const intervalMinutes = parseNumber(getValue("--intervalMinutes"));

    return {
        directory,
        network: parseNetwork(),
        replicate: !getFlag("--no-replicate"),
        intervalMs,
        intervalMinutes,
        runOnStart: !getFlag("--no-runOnStart"),
        runOnce: getFlag("--runOnce") || getFlag("--once"),
        dryRun: getFlag("--dryRun") || getFlag("--dry-run"),
        prefix: getValue("--prefix"),
        scopeAddress: getValue("--scopeAddress") ?? getValue("--scope"),
        parentCanvasId: getValue("--parentCanvasId") ?? getValue("--parent"),
    };
};

const printHelp = () => {
    console.log(`
giga-app-joke-bot

Usage:
  giga-app-joke-bot [--directory <path>] [--intervalMinutes <n>] [--dryRun]

Options:
  --directory, --dir        Peerbit data directory (default: ~/peerbit-giga-bots/joke-bot)
  --network                 prod | local | offline (default: prod)
  --prod                    Alias for --network prod
  --local                   Alias for --network local (dials http://localhost:8082/peer/id)
  --offline                 Alias for --network offline (no dial/bootstrap)
  --intervalMs              Post interval in milliseconds (default: 60000)
  --intervalMinutes         Post interval in minutes (overrides default)
  --no-replicate            Disable root replication
  --no-runOnStart           Do not post immediately on start (continuous mode)
  --runOnce, --once         Post once and exit
  --dryRun                  Print post markdown instead of publishing
  --prefix                  Markdown title prefix

Target (optional):
  --scopeAddress, --scope   Post within a specific Scope address
  --parentCanvasId, --parent Post under a specific parent Canvas id (base64/base64url of canvas.id)
`);
};

async function promptIfInteractive(defaults: CliArgs): Promise<CliArgs> {
    const directoryInput = await input({
        message: "Peerbit data directory",
        default: defaults.directory,
    });

    const network = await select({
        message: "Network",
        choices: [
            { name: "Prod (giga servers)", value: "prod" as const },
            { name: "Local relay", value: "local" as const },
            { name: "Offline (no dial/bootstrap)", value: "offline" as const },
        ],
        default:
            defaults.network === "offline"
                ? 2
                : defaults.network === "local"
                  ? 1
                  : 0,
    });

    const mode = await select({
        message: "Mode",
        choices: [
            { name: "Run continuously", value: "continuous" as const },
            {
                name: "Run once (post one joke and exit)",
                value: "once" as const,
            },
        ],
        default: defaults.runOnce ? 1 : 0,
    });

    const intervalMinutes =
        mode === "continuous"
            ? await input({
                  message: "Interval (minutes)",
                  default: String(defaults.intervalMinutes ?? 5),
                  validate: (value) =>
                      Number.isFinite(Number(value)) && Number(value) >= 0
                          ? true
                          : "Enter a non-negative number",
              }).then((value) => Number(value))
            : undefined;

    const dryRun = await select({
        message: "Publish mode",
        choices: [
            { name: "Dry-run (print markdown)", value: true },
            { name: "Publish to network", value: false },
        ],
        default: defaults.dryRun ? 0 : 1,
    });

    const prefix = await input({
        message: "Title prefix",
        default: defaults.prefix ?? "Joke bot",
    });

    const targetMode = await select({
        message: "Post target",
        choices: [
            { name: "Public Giga root (default)", value: "default" as const },
            { name: "Custom scope/canvas", value: "custom" as const },
        ],
        default: defaults.scopeAddress || defaults.parentCanvasId ? 1 : 0,
    });

    const scopeAddress =
        targetMode === "custom"
            ? (
                  await input({
                      message: "Scope address (optional)",
                      default: defaults.scopeAddress ?? "",
                  })
              ).trim() || undefined
            : undefined;

    const parentCanvasId =
        targetMode === "custom"
            ? (
                  await input({
                      message: "Parent canvas id (optional)",
                      default: defaults.parentCanvasId ?? "",
                  })
              ).trim() || undefined
            : undefined;

    return {
        ...defaults,
        directory: directoryInput,
        network,
        runOnce: mode === "once",
        intervalMinutes,
        dryRun,
        prefix,
        scopeAddress,
        parentCanvasId,
        runOnStart: defaults.runOnStart,
    };
}

export const start = async () => {
    if (getFlag("--help") || getFlag("-h")) {
        printHelp();
        return;
    }

    const defaults = parseArgs();
    const interactive = getFlag("--interactive") || process.argv.length <= 2;
    const args = interactive ? await promptIfInteractive(defaults) : defaults;

    if (args.directory && !fs.existsSync(args.directory)) {
        fs.mkdirSync(args.directory, { recursive: true });
    }

    const client = await Peerbit.create({
        directory: args.directory ?? undefined,
    });

    if (args.network === "offline") {
        console.log("Offline mode: skipping dial/bootstrap");
    } else if (args.network === "local") {
        const localPeerId = await (
            await fetch("http://localhost:8082/peer/id")
        ).text();
        await client.dial("/ip4/127.0.0.1/tcp/8002/ws/p2p/" + localPeerId);
        console.log("Dialed local node", localPeerId);
    } else {
        await client.bootstrap([...BOOTSTRAP_ADDRS]);
    }

    await client.open(new JokeBot(), {
        existing: "reuse",
        args: {
            replicate: args.replicate,
            scopeAddress: args.scopeAddress,
            parentCanvasId: args.parentCanvasId,
            intervalMs: args.intervalMs,
            intervalMinutes: args.intervalMinutes,
            runOnStart: args.runOnStart,
            runOnce: args.runOnce,
            dryRun: args.dryRun,
            prefix: args.prefix,
        },
    });

    if (args.runOnce) {
        await client.stop();
        return;
    }

    console.log("Joke bot running. Press Ctrl+C to stop.");
    const stop = async () => {
        console.log("Stopping...");
        await client.stop();
        process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
};
