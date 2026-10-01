// The adapter's cgofuse loads the first of these libraries that exists
// (fuse/host_cgo.go), so a host with both runtimes mounts through macFUSE.
const macFuseRuntimeLibraries = [
    { library: "/usr/local/lib/libfuse.2.dylib", runtime: "macFUSE" },
    { library: "/usr/local/lib/libosxfuse.2.dylib", runtime: "macFUSE" },
    { library: "/usr/local/lib/libfuse-t.dylib", runtime: "FUSE-T" },
] as const;

export type MacFuseRuntime =
    (typeof macFuseRuntimeLibraries)[number]["runtime"];

export type MacFuseRuntimeStatus = {
    /** The runtime the adapter will load, if any. */
    runtime?: MacFuseRuntime;
    missing: string[];
    notes: string[];
};

export const detectMacFuseRuntime = async (
    pathExists: (path: string) => Promise<boolean>
): Promise<MacFuseRuntimeStatus> => {
    const installed = new Set<MacFuseRuntime>();
    for (const { library, runtime } of macFuseRuntimeLibraries) {
        if (await pathExists(library)) {
            installed.add(runtime);
        }
    }
    if (installed.has("macFUSE")) {
        return {
            runtime: "macFUSE",
            missing: [],
            notes: [
                "macOS native mounts will use macFUSE, whose kernel extension must be approved in System Settings.",
                ...(installed.has("FUSE-T")
                    ? [
                          "FUSE-T is also installed but unused: the adapter loads macFUSE first.",
                      ]
                    : []),
            ],
        };
    }
    if (installed.has("FUSE-T")) {
        return {
            runtime: "FUSE-T",
            missing: [],
            notes: [
                "macOS native mounts will use FUSE-T, which the adapter loads when macFUSE is absent; shared-fs CI does not test FUSE-T.",
            ],
        };
    }
    return {
        missing: ["macFUSE"],
        notes: [
            "macOS native mounts need macFUSE, a kernel extension that must be approved in System Settings.",
        ],
    };
};
