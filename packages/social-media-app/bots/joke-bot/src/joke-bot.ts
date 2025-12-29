import { variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    BotRunner,
    type BotJob,
    type BotJobContext,
    resolveBotTarget,
    parseBooleanArg,
    parseIntervalMs,
    publishMarkdownReply,
} from "@giga-app/bot-kit";

type Args = {
    replicate?: boolean | string;
    scopeAddress?: string;
    parentCanvasId?: string;
    intervalMs?: number | string;
    intervalMinutes?: number | string;
    runOnStart?: boolean | string;
    runOnce?: boolean | string;
    dryRun?: boolean | string;
    prefix?: string;
};

const DEFAULT_JOKES = [
    "Why do programmers prefer dark mode? Because light attracts bugs.",
    "A SQL query walks into a bar, walks up to two tables and asks: “Can I join you?”",
    "I would tell you a UDP joke, but you might not get it.",
    "There are 10 kinds of people: those who understand binary and those who don’t.",
    "Two bytes walk into a bar. The first says, “I’ll have a pint.” The second says, “I’ll have a half pint.”",
];

@variant("joke-bot")
export class JokeBot extends Program<Args> {
    private runner?: BotRunner;
    private lastJokeIndex: number | undefined;

    async open(args?: Args): Promise<void> {
        if (this.runner) return;

        const replicate = parseBooleanArg(args?.replicate, true);
        const { scope, parent: root } = await resolveBotTarget(this.node, {
            replicate,
            scopeAddress: args?.scopeAddress,
            parentCanvasId: args?.parentCanvasId,
        });

        const intervalMs = parseIntervalMs({
            intervalMs: args?.intervalMs,
            intervalMinutes: args?.intervalMinutes,
            defaultMs: 60_000,
        });
        const runOnStart = parseBooleanArg(args?.runOnStart, true);
        const runOnce = parseBooleanArg(args?.runOnce, false);
        const dryRun = parseBooleanArg(args?.dryRun, false);
        const prefix = args?.prefix?.trim() || "Joke bot";

        const job: BotJob = {
            id: "joke",
            intervalMs,
            run: async ({ log }) => {
                const joke = this.pickJoke(DEFAULT_JOKES);
                const markdown =
                    `### ${prefix}\n\n` +
                    `${joke}\n\n` +
                    `_Posted: ${new Date().toISOString()}_`;

                if (dryRun) {
                    log(markdown);
                    return;
                }

                await publishMarkdownReply({
                    node: this.node,
                    scope,
                    parent: root,
                    markdown,
                });
            },
        };

        const ctx: BotJobContext = {
            node: this.node,
            scope,
            root,
            log: (...a: any[]) => console.log("[JokeBot]", ...a),
            error: (...a: any[]) => console.error("[JokeBot]", ...a),
        };

        if (runOnce) {
            await job.run(ctx);
            console.log(`[JokeBot] runOnce finished (dryRun=${dryRun})`);
            return;
        }

        this.runner = new BotRunner({
            runOnStart,
            jobs: [job],
            ctx,
        });

        this.runner.start();
        console.log(
            `[JokeBot] started (intervalMs=${intervalMs}, replicate=${replicate}, dryRun=${dryRun})`
        );
    }

    async close(from?: Program): Promise<boolean> {
        const closed = await super.close(from);
        if (closed) {
            this.runner?.stop();
            this.runner = undefined;
        }
        return closed;
    }

    private pickJoke(jokes: string[]): string {
        if (jokes.length === 0) return "No jokes configured.";
        if (jokes.length === 1) return jokes[0];

        let i = Math.floor(Math.random() * jokes.length);
        if (this.lastJokeIndex != null && jokes.length > 1) {
            let guard = 0;
            while (i === this.lastJokeIndex && guard++ < 10) {
                i = Math.floor(Math.random() * jokes.length);
            }
        }
        this.lastJokeIndex = i;
        return jokes[i];
    }
}
