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
