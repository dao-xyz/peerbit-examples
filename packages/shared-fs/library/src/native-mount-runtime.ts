/** The adapter's own startup error on a Mac with FUSE-T but no macFUSE. */
export const FUSE_T_UNSUPPORTED =
    "FUSE-T is not supported: install macFUSE (brew install --cask macfuse) to mount on macOS; FUSE-T can stay installed. Found FUSE-T's /usr/local/lib/libfuse-t.dylib but not macFUSE's /usr/local/lib/libfuse.2.dylib or /usr/local/lib/libosxfuse.2.dylib.";

export type MacFuseRuntimeStatus = {
    /** Set when the adapter will mount through macFUSE. */
    runtime?: "macFUSE";
    /** Set when the adapter would refuse to mount: FUSE-T without macFUSE. */
    refusal?: string;
    missing: string[];
    notes: string[];
};

export const detectMacFuseRuntime = async (
    pathExists: (path: string) => Promise<boolean>
): Promise<MacFuseRuntimeStatus> => {
    // The adapter's cgofuse loads the first of these libraries that exists
    // (fuse/host_cgo.go), and the adapter refuses to mount through FUSE-T
    // (native/mount_options.go), so only macFUSE counts.
    const macFuse =
        (await pathExists("/usr/local/lib/libfuse.2.dylib")) ||
        (await pathExists("/usr/local/lib/libosxfuse.2.dylib"));
    const fuseT = await pathExists("/usr/local/lib/libfuse-t.dylib");
    if (macFuse) {
        return {
            runtime: "macFUSE",
            missing: [],
            notes: [
                "macOS native mounts will use macFUSE, whose kernel extension must be approved in System Settings.",
                ...(fuseT
                    ? [
                          "FUSE-T is also installed but unused: the adapter loads macFUSE first.",
                      ]
                    : []),
            ],
        };
    }
    const notes = [
        "macOS native mounts need macFUSE, a kernel extension that must be approved in System Settings.",
    ];
    return fuseT
        ? {
              refusal: FUSE_T_UNSUPPORTED,
              missing: ["macFUSE"],
              notes: [FUSE_T_UNSUPPORTED, ...notes],
          }
        : { missing: ["macFUSE"], notes };
};
