// Runtime monkey-patch profiler for tests.
// Guards via SCOPE_OPEN_PROFILE env var.

if (typeof process !== "undefined" && process.env.SCOPE_OPEN_PROFILE) {
    try {
        const doc = require("@peerbit/document");
        const log = require("@peerbit/log");
        const sharedLog = require("@peerbit/shared-log");
        const sqlite3 = require("@peerbit/indexer-sqlite3");

        const wrapAsync = (obj: any, name: string) => {
            if (
                !obj ||
                !obj.prototype ||
                typeof obj.prototype[name] !== "function"
            )
                return;
            const orig = obj.prototype[name];
            obj.prototype[name] = async function (...args: any[]) {
                const t0 = performance.now();
                const res = await orig.apply(this, args);
                const t1 = performance.now();
                console.log(
                    `[SCOPE_OPEN_PROFILE] ${obj.name}.${name}: ${(
                        t1 - t0
                    ).toFixed(2)}ms`
                );
                return res;
            };
        };

        wrapAsync(doc.Documents, "open");
        wrapAsync(log.Log, "open");
        wrapAsync(sharedLog.SharedLog, "open");

        // Wrap sqlite3 create to instrument db.open and prepare
        if (sqlite3 && sqlite3.create) {
            const origCreate = sqlite3.create;
            sqlite3.create = async function (...args: any[]) {
                const db = await origCreate.apply(this, args);
                const origOpen = db.open.bind(db);
                db.open = async function () {
                    const t0 = performance.now();
                    const res = await origOpen();
                    const t1 = performance.now();
                    console.log(
                        `[SCOPE_OPEN_PROFILE] better-sqlite3.open: ${(
                            t1 - t0
                        ).toFixed(2)}ms`
                    );
                    return res;
                };

                const origPrepare = db.prepare.bind(db);
                db.prepare = function (sql: string, id?: string) {
                    const t0 = performance.now();
                    const stmt = origPrepare(sql, id);
                    const t1 = performance.now();
                    console.log(
                        `[SCOPE_OPEN_PROFILE] better-sqlite3.prepare: ${(
                            t1 - t0
                        ).toFixed(2)}ms sql=${sql
                            .slice(0, 40)
                            .replace(/\n/g, " ")}...`
                    );
                    return stmt;
                };

                return db;
            };
        }
    } catch (e) {
        // best-effort
        console.error("monkey-profiler failed to install", e);
    }
}
