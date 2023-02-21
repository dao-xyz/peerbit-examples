/* 
ISC License (ISC)
Copyright (c) 2016, Wes Cruver <chieffancypants@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/

import debugFn from "debug";
const debug = debugFn("FastMutex");

/**
 * Helper function to create a randomId to distinguish between different
 * FastMutex clients.  localStorage uses strings, so explicitly cast to string:
 */
const randomId = () => Math.random() + "";

/**
 * Helper function to calculate the endTime, lock acquisition time, and then
 * resolve the promise with all the lock stats
 */
const resolveWithStats = (resolve, stats) => {
    const currentTime = new Date().getTime();
    stats.acquireEnd = currentTime;
    stats.acquireDuration = stats.acquireEnd - stats.acquireStart;
    stats.lockStart = currentTime;
    resolve(stats);
};

export type LockStats = {
    restartCount: number;
    locksLost: number;
    contentionCount: number;
    acquireDuration: number;
    acquireStart?: number;
    lockEnd?: number;
    lockStart?: number;
    lockDuration?: number;
};
export class FastMutex {
    clientId: string;
    xPrefix: string;
    yPrefix: string;
    timeout: number;
    localStorage: any;
    lockStats: LockStats;
    intervals: Map<string, any>;

    constructor({
        clientId = randomId(),
        xPrefix = "_MUTEX_LOCK_X_",
        yPrefix = "_MUTEX_LOCK_Y_",
        timeout = 5000,
        localStorage = undefined,
    } = {}) {
        this.clientId = clientId;
        this.xPrefix = xPrefix;
        this.yPrefix = yPrefix;
        this.timeout = timeout;
        this.intervals = new Map();

        this.localStorage = localStorage || window.localStorage;
        this.resetStats();
    }

    lock(key: string, keepLocked?: () => boolean): Promise<LockStats> {
        debug(
            'Attempting to acquire Lock on "%s" using FastMutex instance "%s"',
            key,
            this.clientId
        );
        const x = this.xPrefix + key;
        const y = this.yPrefix + key;
        this.resetStats();

        if (!this.lockStats.acquireStart) {
            this.lockStats.acquireStart = new Date().getTime();
        }

        return new Promise((resolve, reject) => {
            // we need to differentiate between API calls to lock() and our internal
            // recursive calls so that we can timeout based on the original lock() and
            // not each subsequent call.  Therefore, create a new function here within
            // the promise closure that we use for subsequent calls:
            const acquireLock = (key) => {
                if (this.lockStats.acquireStart == null) {
                    reject(new Error("Unexpected, missing acquire start"));
                    return;
                }

                const elapsedTime =
                    new Date().getTime() - this.lockStats.acquireStart;
                if (elapsedTime >= this.timeout) {
                    debug(
                        'Lock on "%s" could not be acquired within %sms by FastMutex client "%s"',
                        key,
                        this.timeout,
                        this.clientId
                    );
                    return reject(
                        new Error(
                            `Lock could not be acquired within ${this.timeout}ms`
                        )
                    );
                }

                this.setItem(x, this.clientId, keepLocked);

                // if y exists, another client is getting a lock, so retry in a bit
                let lsY = this.getItem(y);
                if (lsY) {
                    debug("Lock exists on Y (%s), restarting...", lsY);
                    this.lockStats.restartCount++;
                    setTimeout(() => acquireLock(key));
                    return;
                }

                // ask for inner lock
                this.setItem(y, this.clientId, keepLocked);

                // if x was changed, another client is contending for an inner lock
                let lsX = this.getItem(x);
                if (lsX !== this.clientId) {
                    this.lockStats.contentionCount++;
                    debug('Lock contention detected. X="%s"', lsX);

                    // Give enough time for critical section:
                    setTimeout(() => {
                        lsY = this.getItem(y);
                        if (lsY === this.clientId) {
                            // we have a lock
                            debug(
                                'FastMutex client "%s" won the lock contention on "%s"',
                                this.clientId,
                                key
                            );
                            resolveWithStats(resolve, this.lockStats);
                        } else {
                            // we lost the lock, restart the process again
                            this.lockStats.restartCount++;
                            this.lockStats.locksLost++;
                            debug(
                                'FastMutex client "%s" lost the lock contention on "%s" to another process (%s). Restarting...',
                                this.clientId,
                                key,
                                lsY
                            );
                            setTimeout(() => acquireLock(key));
                        }
                    }, 50);
                    return;
                }

                // no contention:
                debug(
                    'FastMutex client "%s" acquired a lock on "%s" with no contention',
                    this.clientId,
                    key
                );
                resolveWithStats(resolve, this.lockStats);
            };

            acquireLock(key);
        });
    }

    isLocked(key: string) {
        const x = this.xPrefix + key;
        const y = this.yPrefix + key;
        return !!this.getItem(x) || !!this.getItem(y);
    }

    getLockedInfo(key: string): string | null {
        const x = this.xPrefix + key;
        const y = this.yPrefix + key;
        return this.getItem(x) || this.getItem(y);
    }

    release(key: string) {
        debug(
            'FastMutex client "%s" is releasing lock on "%s"',
            this.clientId,
            key
        );
        const y = this.yPrefix + key;
        return new Promise((resolve, reject) => {
            clearInterval(this.intervals.get(y));
            this.localStorage.removeItem(y);
            this.lockStats.lockEnd = new Date().getTime();

            if (this.lockStats.lockStart == null) {
                reject(new Error("Unexpected, missing lock start"));
                return;
            }
            this.lockStats.lockDuration =
                this.lockStats.lockEnd - this.lockStats.lockStart;
            resolve(this.lockStats);
            this.resetStats();
        });
    }

    /**
     * Helper function to wrap all values in an object that includes the time (so
     * that we can expire it in the future) and json.stringify's it
     */
    setItem(key: string, value: any, keepLocked?: () => boolean) {
        if (!keepLocked) {
            return this.localStorage.setItem(
                key,
                JSON.stringify({
                    expiresAt: new Date().getTime() + this.timeout,
                    value,
                })
            );
        } else {
            let getExpiry = () => +new Date() + this.timeout;
            const ret = this.localStorage.setItem(
                key,
                JSON.stringify({
                    expiresAt: getExpiry(),
                    value,
                })
            );
            const interval = setInterval(() => {
                if (!keepLocked()) {
                    this.localStorage.setItem(
                        // TODO, release directly?
                        key,
                        JSON.stringify({
                            expiresAt: 0,
                            value,
                        })
                    );
                } else {
                    this.localStorage.setItem(
                        key,
                        JSON.stringify({
                            expiresAt: getExpiry(), // bump expiry
                            value,
                        })
                    );
                }
            }, this.timeout);
            this.intervals.set(key, interval);
            return ret;
        }
    }

    /**
     * Helper function to parse JSON encoded values set in localStorage
     */
    getItem(key: string): string | null {
        const item = this.localStorage.getItem(key);
        if (!item) return null;

        const parsed = JSON.parse(item);
        if (new Date().getTime() - parsed.expiresAt >= this.timeout) {
            debug(
                'FastMutex client "%s" removed an expired record on "%s"',
                this.clientId,
                key
            );
            this.localStorage.removeItem(key);
            clearInterval(this.intervals.get(key));
            this.intervals.delete(key);
            return null;
        }

        return JSON.parse(item).value;
    }

    /**
     * Helper function to reset statistics. A single FastMutex client can be used
     * to perform multiple successive lock()s so we need to reset stats each time
     */
    resetStats() {
        this.lockStats = {
            restartCount: 0,
            locksLost: 0,
            contentionCount: 0,
            acquireDuration: 0,
            acquireStart: undefined,
        };
    }
}
