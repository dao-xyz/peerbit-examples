import type { ProgramClient } from "@peerbit/program";
import type { Canvas, Scope } from "@giga-app/interface";

export type BotJobContext = {
    node: ProgramClient;
    scope: Scope;
    root: Canvas;
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
};

export type BotJob = {
    id: string;
    intervalMs: number;
    run: (ctx: BotJobContext) => Promise<void>;
};

type Timer = ReturnType<typeof setTimeout>;

export class BotRunner {
    private readonly jobs: BotJob[];
    private readonly ctx: BotJobContext;
    private readonly runOnStart: boolean;

    private stopped = true;
    private timers = new Map<string, Timer>();
    private running = new Set<string>();

    constructor(options: {
        jobs: BotJob[];
        ctx: BotJobContext;
        runOnStart?: boolean;
    }) {
        this.jobs = options.jobs;
        this.ctx = options.ctx;
        this.runOnStart = options.runOnStart ?? true;
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;

        for (const job of this.jobs) {
            if (this.runOnStart) {
                void this.runJob(job).catch(() => {});
            }
            this.schedule(job);
        }
    }

    stop() {
        this.stopped = true;
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.running.clear();
    }

    private schedule(job: BotJob) {
        if (this.stopped) return;

        const timer = setTimeout(async () => {
            try {
                await this.runJob(job);
            } finally {
                this.schedule(job);
            }
        }, job.intervalMs);

        this.timers.set(job.id, timer);
    }

    private async runJob(job: BotJob) {
        if (this.stopped) return;
        if (this.running.has(job.id)) return;

        this.running.add(job.id);
        try {
            await job.run(this.ctx);
        } catch (error) {
            this.ctx.error(`[BotRunner] job failed: ${job.id}`, error);
        } finally {
            this.running.delete(job.id);
        }
    }
}
