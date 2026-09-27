/**
 * Parks the first queryRows call after its rows return (a genuine
 * pre-event snapshot), restores the original for every later caller, and
 * hands back the release valve. Shared by the cache-race test files.
 */
export const parkNextRowQuery = (program: any) => {
    const original = program.queryRows.bind(program);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let parked = false;
    const parkedReached = new Promise<void>((resolve) => {
        program.queryRows = async (query: unknown) => {
            const rows = await original(query);
            if (!parked) {
                parked = true;
                program.queryRows = original;
                resolve();
                await gate;
            }
            return rows;
        };
    });
    return { release, parkedReached };
};

/**
 * Makes every directory count as wide for `program`, including on point
 * caches that open/close/overlay retirement swap in, so lookups take the
 * exact-slot path under test (a narrow directory is otherwise read and
 * cached whole). `isWide` stays synchronous, so await structure is unchanged.
 * Returns an undo function.
 */
export const forcePointTier = (program: any) => {
    const forceWide = (cache: any) => {
        cache.isWide = () => true;
        return cache;
    };
    let pointCache = forceWide(program.slotPointCache);
    Object.defineProperty(program, "slotPointCache", {
        configurable: true,
        get: () => pointCache,
        set: (cache: any) => {
            pointCache = forceWide(cache);
        },
    });
    return () => {
        delete pointCache.isWide;
        delete program.slotPointCache;
        program.slotPointCache = pointCache;
    };
};
