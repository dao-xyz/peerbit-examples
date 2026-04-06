import { usePeer, useProgram } from "@peerbit/react";
import { useNavigate, useParams } from "react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { Files, AbstractFile, LargeFile } from "@peerbit/please-lib";
import * as Toggle from "@radix-ui/react-toggle";
import { MdArrowBack, MdUploadFile, MdClose, MdSettings } from "react-icons/md";
import { FaSeedling } from "react-icons/fa";
import { File } from "./File";
import { Spinner } from "./Spinner";
import * as Switch from "@radix-ui/react-switch";
import * as Slider from "@radix-ui/react-slider";
import { SearchRequest } from "@peerbit/document";
import * as Popover from "@radix-ui/react-popover";
import { useStorageUsage } from "./MemoryUsage";
import { useNetworkUsage } from "./NetworkUsage";
import { GraphExplorer } from "./Graphs";
import * as Progress from "@radix-ui/react-progress";
import { ReplicationOptions } from "@peerbit/shared-log";

const saveRoleLocalStorage = (files: Files, role: string) => {
    localStorage.setItem(files.address + "-role", role); // Save role in localstorage for next time
};
const getRoleFromLocalStorage = (files: Files) => {
    return localStorage.getItem(files.address + "-role"); // Save role in localstorage for next time
};

const DEFAULT_REPLICATION_ROLE: ReplicationOptions = {
    limits: { cpu: { max: 1, monitor: undefined } },
};

const parseStoredRole = (
    serializedRole: string | null
): ReplicationOptions | undefined =>
    serializedRole == null ? undefined : JSON.parse(serializedRole);

const STREAMING_DOWNLOAD_THRESHOLD_BYTES = 250_000_000n;

type BrowserFileWriter = {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
};

type ListingDiagnostics = {
    mountedAt: number;
    shareAddress: string | null;
    initialRole: "replicator" | "replicator-default" | "observer";
    onOpenStartedAt: number | null;
    trustCheckStartedAt: number | null;
    trustCheckFinishedAt: number | null;
    firstListSource: string | null;
    firstListStartedAt: number | null;
    firstListFinishedAt: number | null;
    firstListDurationMs: number | null;
    firstMetadataRefreshFinishedAt: number | null;
    updateRoleCount: number;
    lastUpdateRoleStartedAt: number | null;
    lastUpdateRoleFinishedAt: number | null;
    lastAppliedRole: "replicator" | "observer" | null;
    listCallCount: number;
};

type SaveFilePickerWindow = Window & {
    showSaveFilePicker?: (options?: {
        suggestedName?: string;
    }) => Promise<{
        createWritable(): Promise<BrowserFileWriter>;
    }>;
    __peerbitStreamingDownloadThresholdBytes?: number;
};

const isUserCancelledDownload = (error: unknown) =>
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "NotAllowedError");

const getStreamingDownloadThresholdBytes = () => {
    const override = (window as SaveFilePickerWindow)
        .__peerbitStreamingDownloadThresholdBytes;
    if (typeof override === "number" && Number.isFinite(override)) {
        return BigInt(Math.max(0, Math.floor(override)));
    }
    return STREAMING_DOWNLOAD_THRESHOLD_BYTES;
};

const getFileSizeBigInt = (file: AbstractFile) =>
    typeof file.size === "bigint" ? file.size : BigInt(file.size);

const createListingDiagnostics = (
    shareAddress: string | undefined,
    storedRole: ReplicationOptions | undefined
): ListingDiagnostics => ({
    mountedAt: Date.now(),
    shareAddress: shareAddress ?? null,
    initialRole:
        storedRole === false
            ? "observer"
            : storedRole
              ? "replicator"
              : "replicator-default",
    onOpenStartedAt: null,
    trustCheckStartedAt: null,
    trustCheckFinishedAt: null,
    firstListSource: null,
    firstListStartedAt: null,
    firstListFinishedAt: null,
    firstListDurationMs: null,
    firstMetadataRefreshFinishedAt: null,
    updateRoleCount: 0,
    lastUpdateRoleStartedAt: null,
    lastUpdateRoleFinishedAt: null,
    lastAppliedRole: null,
    listCallCount: 0,
});

export const useDebouncedEffect = (effect, deps, delay) => {
    useEffect(() => {
        const handler = setTimeout(() => effect(), delay);

        return () => clearTimeout(handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...(deps || []), delay]);
};

function callEvenInterval(func, delay) {
    var timer: ReturnType<typeof setTimeout> = undefined;
    let promise: any = undefined;
    return function debouncedFn(args?: any) {
        if (timer || promise) {
            return;
        }
        timer = setTimeout(async () => {
            promise = func(args);
            await promise;
            promise = undefined;
            timer = undefined;
        }, delay);
    };
}

export const Drop = () => {
    const navigate = useNavigate();

    const { peer } = usePeer();

    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const [list, setList] = useState<AbstractFile[]>([]);

    const [replicationSet, setReplicationSet] = useState<Set<string>>(
        new Set()
    );
    const [isHost, setIsHost] = useState<boolean>();
    const [currentRole, setCurrentRole] = useState<ReplicationOptions>(false);
    const [replicatorCount, setReplicatorCount] = useState(0);
    const [left, setLeft] = useState(false);
    const shareAddress = params.address && decodeURIComponent(params.address);
    const storedRole = parseStoredRole(
        typeof window === "undefined" || !shareAddress
            ? null
            : window.localStorage.getItem(`${shareAddress}-role`)
    );
    const diagnosticsRef = useRef<ListingDiagnostics>(
        createListingDiagnostics(shareAddress, storedRole)
    );

    useEffect(() => {
        diagnosticsRef.current = createListingDiagnostics(shareAddress, storedRole);
        // Reset diagnostics only when we enter a different share. Role changes
        // inside the same share are part of the same session we want to measure.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shareAddress]);

    const files = useProgram<Files>(
        peer,
        shareAddress,
        {
            existing: "reuse",
            args: {
                replicate: storedRole ?? DEFAULT_REPLICATION_ROLE,
            },
        }
    );

    const { memory } = useStorageUsage(files.program?.files.log);
    const { up, down } = useNetworkUsage();
    const [limitStorageString, setLimitStorageString] = useState<string>("0");
    const [limitStorage, setLimitStorage] = useState<boolean>(false);

    const [role, setRole] = useState<"replicator" | "observer">(
        storedRole === false ? "observer" : "replicator"
    );
    const [limitCPU, setLimitCPU] = useState<number | undefined>(1);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);

    // we exclude the string type 'replicator' | 'observer' from the roleOptions so that we can easily serialize it with JSON
    const updateRole = async (roleOptions?: ReplicationOptions) => {
        if (roleOptions == null || !files.program) {
            return;
        }

        diagnosticsRef.current.updateRoleCount += 1;
        diagnosticsRef.current.lastAppliedRole =
            roleOptions === false ? "observer" : "replicator";
        diagnosticsRef.current.lastUpdateRoleStartedAt = Date.now();

        files.program.persistChunkReads = roleOptions !== false;

        // console.log("X", files.program.files.log["_roleOptions"]?.["limits"]?.["cpu"]?.max)
        saveRoleLocalStorage(files.program, JSON.stringify(roleOptions)); // Save role in localstorage for next time
        await files.program.files.log.replicate(false);
        if (roleOptions !== false) {
            await files.program.files.log.replicate(roleOptions);
        }
        diagnosticsRef.current.lastUpdateRoleFinishedAt = Date.now();
    };

    useEffect(() => {
        const testWindow = window as Window & {
            __peerbitFileShareTestHooks?: {
                setReplicationRole: (
                    roleOptions: ReplicationOptions
                ) => Promise<void>;
                getDiagnostics: () => Promise<Record<string, unknown>>;
            };
        };
        if (!files.program || files.program.closed) {
            delete testWindow.__peerbitFileShareTestHooks;
            return;
        }
        testWindow.__peerbitFileShareTestHooks = {
            setReplicationRole: async (roleOptions) => {
                saveRoleLocalStorage(files.program, JSON.stringify(roleOptions));
                setRole(roleOptions ? "replicator" : "observer");
                await updateRole(roleOptions);
            },
            getDiagnostics: async () => {
                const replicators = await files.program.files.log
                    .getReplicators()
                    .catch(() => undefined);
                return {
                    programAddress: files.program?.address ?? null,
                    programClosed: files.program?.closed ?? null,
                    persistChunkReads: files.program?.persistChunkReads ?? null,
                    peerHash: peer?.identity?.publicKey?.hashcode?.() ?? null,
                    programOpenDiagnostics:
                        files.program?.openDiagnostics ?? null,
                    replicatorCount:
                        replicators && typeof replicators.size === "number"
                            ? replicators.size
                            : null,
                    listCount: list.length,
                    replicationSetSize: replicationSet.size,
                    isHost: isHost ?? null,
                    left,
                    timings: diagnosticsRef.current,
                };
            },
        };
        return () => {
            delete testWindow.__peerbitFileShareTestHooks;
        };
    }, [
        files.program?.address,
        files.program?.closed,
        isHost,
        left,
        list.length,
        peer?.identity?.publicKey,
        replicationSet.size,
    ]);

    useDebouncedEffect(
        () => {
            const limitSizeMB = Number(limitStorageString);
            const sizeBytes = limitSizeMB * 1e6;

            updateRole(
                role === "replicator"
                    ? {
                          limits: {
                              cpu:
                                  limitCPU != null
                                      ? { max: limitCPU }
                                      : undefined,
                              storage: limitStorage ? sizeBytes : undefined,
                          },
                      }
                    : false
            );
        },
        [limitCPU, limitStorage, role, limitStorageString],
        30
    ); // we debounce because of the many changes the CPU slider will do

    // console.log(files?.program?.files.log?.["cpuUsage"].value())
    useEffect(() => {
        if (!files.program?.address || files.program.closed) {
            return;
        }

        const updateListDebounced = callEvenInterval(updateList, 500);
        const refresh = setInterval(() => {
            updateListDebounced();
        }, 5000);
        files.program.files.log.events.addEventListener("join", updateList);
        files.program.files.log.events.addEventListener(
            "leave",
            updateListDebounced
        );
        files.program.files.events.addEventListener(
            "change",
            updateListDebounced
        );

        const replicatorsChangeListener = async (ev) => {
            setReplicatorCount(
                (await files.program.files.log.getReplicators()).size
            );

            //  setCurrentRole(ev.detail.replicate); TODO this should be somewhere else
        };

        files.program.files.log.events.addEventListener(
            "replication:change",
            replicatorsChangeListener
        );

        let onOpen = async () => {
            diagnosticsRef.current.onOpenStartedAt = Date.now();

            const serializedRoleFromStorage = getRoleFromLocalStorage(
                files.program
            );
            const hasStoredRole = serializedRoleFromStorage != null;
            const roleFromLocalstore = parseStoredRole(
                serializedRoleFromStorage
            );
            const desiredRole =
                hasStoredRole
                    ? roleFromLocalstore
                    : role === "replicator"
                      ? DEFAULT_REPLICATION_ROLE
                      : false;

            files.program.persistChunkReads = desiredRole !== false;
            setRole(desiredRole === false ? "observer" : "replicator");
            void updateList("initial-open");

            diagnosticsRef.current.trustCheckStartedAt = Date.now();
            const isTrusted =
                !files.program.trustGraph ||
                (await files.program.trustGraph.isTrusted(
                    peer.identity.publicKey
                ));
            diagnosticsRef.current.trustCheckFinishedAt = Date.now();
            setIsHost(isTrusted);

            files.program = files.program;
            if (isTrusted && hasStoredRole) {
                setLimitCPU(
                    files.program.files.log["_roleOptions"]?.["limits"]?.["cpu"]
                        ?.max
                ); // TODO export types
                const limitStorageLoaded =
                    files.program.files.log["_roleOptions"]?.["limits"]?.memory;
                setLimitStorage(limitStorageLoaded != null); // TODO export types
                setLimitStorageString(
                    limitStorageLoaded != null
                        ? String(limitStorageLoaded)
                        : "0"
                ); // TODO export types
            }

            const replicators = await files.program.files.log.getReplicators();
            setReplicatorCount(replicators.size);
        };

        onOpen();

        return () => {
            clearInterval(refresh);

            files.program.files.log.events.removeEventListener(
                "join",
                updateList
            );
            files.program.files.log.events.removeEventListener(
                "leave",
                updateListDebounced
            );
            files.program.files.events.removeEventListener(
                "change",
                updateListDebounced
            );
            files.program.files.log.events.removeEventListener(
                "replication:change",
                replicatorsChangeListener
            );
            files.program.events.removeEventListener("open", onOpen);
        };
    }, [files.program?.address, files.program?.closed]);

    const updateList = async (sourceOrEvent: string | Event = "refresh") => {
        if (files.program.files.log.closed) {
            return;
        }

        const source =
            typeof sourceOrEvent === "string" ? sourceOrEvent : "event";

        // TODO don't reload the whole list, just add the new elements..
        try {
            diagnosticsRef.current.listCallCount += 1;
            const startedAt = Date.now();
            if (diagnosticsRef.current.firstListStartedAt == null) {
                diagnosticsRef.current.firstListStartedAt = startedAt;
                diagnosticsRef.current.firstListSource = source;
            }
            const list = await files.program.list();
            const finishedAt = Date.now();
            if (diagnosticsRef.current.firstListFinishedAt == null) {
                diagnosticsRef.current.firstListFinishedAt = finishedAt;
                diagnosticsRef.current.firstListDurationMs =
                    finishedAt - startedAt;
            }
            setList(
                list
                    .filter((x) => !x.parentId)
                    .sort((a, b) => a.name.localeCompare(b.name))
            );
            forceUpdate();
            void (async () => {
                try {
                    const [allFiles, replicators] = await Promise.all([
                        files.program.files.index.search(new SearchRequest({})),
                        files.program.files.log.getReplicators(),
                    ]);
                    setReplicationSet(new Set(allFiles.map((x) => x.id)));
                    setReplicatorCount(replicators.size);
                    if (
                        diagnosticsRef.current.firstMetadataRefreshFinishedAt ==
                        null
                    ) {
                        diagnosticsRef.current.firstMetadataRefreshFinishedAt =
                            Date.now();
                    }
                    forceUpdate();
                } catch (error) {
                    console.warn(
                        "Failed to refresh replication metadata: " +
                            error?.message
                    );
                }
            })();
        } catch (error) {
            console.warn(
                "Failed to resolve complete file list: " + error?.message
            );
        }
    };

    const download = async (
        file: AbstractFile,
        progress: (progress: number | null) => void
    ) => {
        const timeout =
            file instanceof LargeFile
                ? Math.max(
                      60_000,
                      Math.ceil(Number(file.size) / 1e6) * 1_000
                  )
                : 10_000;
        try {
            const saveFilePicker = (window as SaveFilePickerWindow)
                .showSaveFilePicker;

            if (
                saveFilePicker &&
                getFileSizeBigInt(file) >= getStreamingDownloadThresholdBytes()
            ) {
                const handle = await saveFilePicker({
                    suggestedName: file.name,
                }).catch((error) => {
                    if (isUserCancelledDownload(error)) {
                        return undefined;
                    }
                    throw error;
                });
                if (handle) {
                    const writable = await handle.createWritable();
                    await file.writeFile(files.program, writable, {
                        timeout,
                        progress: (value) => {
                            progress(value);
                        },
                    });
                    return;
                }
                return;
            }

            const bytes = await file.getFile(files.program, {
                as: "chunks",
                timeout,
                progress,
            });
            const blob = new Blob(bytes as BlobPart[]);
            const link = document.createElement("a");
            const url = window.URL.createObjectURL(blob);
            link.href = url;
            link.download = file.name;
            link.click();
            setTimeout(() => {
                window.URL.revokeObjectURL(url);
            }, 60_000);
        } finally {
            progress(null);
        }
    };

    function dropHandler(ev) {
        console.log("File(s) dropped");

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        if (!isHost) {
            alert("Not host!");
            ev.stopPropagation();
            return;
        }

        let promises: Promise<any>[] = [];
        setUploadProgress(0);
        if (ev.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            [...ev.dataTransfer.items].forEach((item, i) => {
                // If dropped items aren't files, reject them
                if (item.kind === "file") {
                    const file: File = item.getAsFile();
                    promises.push(addFile([file], false));
                }
            });
        } else {
            // Use DataTransfer interface to access the file(s)
            [...ev.dataTransfer.files].forEach((file, i) => {
                promises.push(addFile([file], false));
            });
        }
        Promise.all(promises).finally(() => {
            setUploadProgress(null);
        });
    }

    const addFile = (filesToAdd: FileList | File[], endProgress = true) => {
        return new Promise<void>((resolve, reject) => {
            let promises: Promise<any>[] = [];

            // there will just by one file here in practice
            for (const file of filesToAdd) {
                promises.push(
                    files.program.addBlob(file.name, file, undefined, (progress) => {
                        setUploadProgress((current) =>
                            current == null ? progress : Math.max(progress, current)
                        );
                    })
                );
            }

            if (promises.length === filesToAdd.length) {
                Promise.all(promises)
                    .then(() => {
                        if (endProgress) {
                            setUploadProgress(null);
                        }
                        updateList();
                        resolve();
                    })
                    .catch((e) => {
                        reject(e);
                    });
            }
        });
    };

    const goBack = () => (
        <button
            className="w-fit btn btn-elevated flex flex-row items-center p-2"
            onClick={() => {
                setLeft(true);
                navigate("/");
            }}
        >
            <MdArrowBack size={20} className="mr-2" /> <span>Create space</span>
        </button>
    );

    function dragOverHandler(ev) {
        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        if (!isHost) {
            return;
        }
    }

    return (
        <>
            {files.loading ? (
                <div className="flex flex-col items-center justify-center content-center h-full gap-4">
                    <div className="flex flex-row gap-4 items-center justify-center">
                        <span className="italic">Loading</span> <Spinner />
                    </div>{" "}
                    {goBack()}
                </div>
            ) : (
                <div
                    onDrop={dropHandler}
                    onDragOver={dragOverHandler}
                    className="flex flex-col h-[calc(100% - 40px)] items-center w-screen h-full  "
                >
                    <div className="max-w-3xl w-full flex flex-col p-4 gap-4 ">
                        <div className="flex flex-row gap-4 items-center">
                            <div className="flex flex-col ">
                                <h1 className="text-3xl italic">
                                    {files.program?.name}
                                </h1>
                                <span className="font-mono text-xs">
                                    Seeders:{" "}
                                    <span
                                        className="!text-green-400"
                                        data-testid="seeder-count"
                                    >
                                        {replicatorCount}
                                    </span>
                                </span>
                                <span className="italic text-xs">
                                    Copy the URL to share all files
                                </span>
                                <span className="text-xs ">
                                    Used storage: {memory} kB
                                </span>
                                <span className="text-xs ">
                                    ↑ {up} kb/s ↓ {down} kb/s
                                </span>
                            </div>

                            <div className="ml-auto flex flex-row items-end gap-2 align-items: center">
                                {isHost && (
                                    <>
                                        <input
                                            type="file"
                                            id="imgupload"
                                            data-testid="upload-input"
                                            className="hidden"
                                            onChange={(e) => {
                                                addFile(e.target?.files);
                                            }}
                                        />
                                        <button
                                            className="w-fit btn btn-elevated flex flex-row items-center gap-2"
                                            onClick={() => {
                                                document
                                                    .getElementById("imgupload")
                                                    .click();
                                            }}
                                        >
                                            <span className="hidden sm:block">
                                                Upload
                                            </span>{" "}
                                            <MdUploadFile size={20} />
                                        </button>
                                    </>
                                )}
                                {!isHost && goBack()}
                            </div>
                            <Toggle.Root
                                data-testid="seed-toggle"
                                onPressedChange={(e) => {
                                    setRole(e ? "replicator" : "observer");
                                }}
                                disabled={!files.program}
                                pressed={role === "replicator"}
                                className="w-fit btn-icon btn-toggle flex flex-row items-center gap-2"
                                aria-label="Toggle italic"
                            >
                                <span className="hidden sm:block">Seed</span>
                                <FaSeedling
                                    className="text-green-400"
                                    size={20}
                                />
                            </Toggle.Root>

                            <Popover.Root>
                                <Popover.Trigger asChild>
                                    <button className="w-fit btn-icon btn-toggle flex flex-row items-center gap-2">
                                        <span className="hidden sm:block">
                                            Settings
                                        </span>
                                        <MdSettings size={20} />
                                    </button>
                                </Popover.Trigger>
                                <Popover.Portal>
                                    <Popover.Content
                                        className="popover-content"
                                        sideOffset={5}
                                    >
                                        <div className="flex flex-col gap-2">
                                            <fieldset className="flex flex-row gap-4">
                                                <label
                                                    className="Label"
                                                    htmlFor="seed"
                                                >
                                                    Seed
                                                </label>
                                                <Switch.Root
                                                    className="SwitchRoot"
                                                    id="seed"
                                                    onCheckedChange={(e) => {
                                                        setRole(
                                                            e
                                                                ? "replicator"
                                                                : "observer"
                                                        );
                                                    }}
                                                    disabled={!files.program}
                                                    checked={
                                                        role === "replicator"
                                                    }
                                                >
                                                    <Switch.Thumb className="SwitchThumb" />
                                                </Switch.Root>
                                            </fieldset>
                                            {role === "replicator" && (
                                                <div className="flex flex-col gap-4 mt-4">
                                                    <span>Limit</span>
                                                    <fieldset className="flex flex-col gap-2">
                                                        <div className="flex flex-row gap-4">
                                                            <label htmlFor="limit-storage">
                                                                Storage
                                                            </label>
                                                            <Switch.Root
                                                                className="SwitchRoot"
                                                                id="limit-storage"
                                                                onCheckedChange={(
                                                                    e
                                                                ) => {
                                                                    setLimitStorage(
                                                                        e
                                                                    );
                                                                }}
                                                                disabled={
                                                                    !files.program
                                                                }
                                                                checked={
                                                                    limitStorage
                                                                }
                                                            >
                                                                <Switch.Thumb className="SwitchThumb" />
                                                            </Switch.Root>
                                                        </div>
                                                        <div className="pl-4 flex flex-col gap-2">
                                                            <span className="text-xs italic">
                                                                Limit how much
                                                                data you want to
                                                                replicate (MB).
                                                                This is an
                                                                approximation of
                                                                real usage
                                                            </span>

                                                            {limitStorage && (
                                                                <input
                                                                    className="p-2"
                                                                    onChange={(
                                                                        v
                                                                    ) => {
                                                                        setLimitStorageString(
                                                                            v
                                                                                .target
                                                                                .value
                                                                        );
                                                                    }}
                                                                    id="storage"
                                                                    type="number"
                                                                    value={
                                                                        limitStorageString ||
                                                                        ""
                                                                    }
                                                                    placeholder="(Mb)"
                                                                ></input>
                                                            )}
                                                        </div>
                                                    </fieldset>
                                                    <fieldset className="flex flex-col gap-2">
                                                        <div className="flex flex-row gap-4">
                                                            <label htmlFor="limit-cpu">
                                                                CPU
                                                            </label>
                                                            <Switch.Root
                                                                className="SwitchRoot"
                                                                id="limit-cpu"
                                                                onCheckedChange={(
                                                                    e
                                                                ) => {
                                                                    setLimitCPU(
                                                                        e
                                                                            ? (limitCPU ??
                                                                                  0)
                                                                            : undefined
                                                                    );
                                                                }}
                                                                disabled={
                                                                    !files.program
                                                                }
                                                                checked={
                                                                    limitCPU !=
                                                                    null
                                                                }
                                                            >
                                                                <Switch.Thumb className="SwitchThumb" />
                                                            </Switch.Root>
                                                        </div>
                                                        <div className="pl-4 flex flex-col gap-2">
                                                            <span className="text-xs italic">
                                                                By limiting
                                                                replication by
                                                                CPU usage, you
                                                                allow the
                                                                replication
                                                                degree to be
                                                                reduced when the
                                                                page gets
                                                                minimized (and
                                                                throttled)
                                                            </span>
                                                            {limitCPU !=
                                                                null && (
                                                                <div className="flex flex-row gap-2">
                                                                    <span className="text-sm">
                                                                        Limited
                                                                    </span>
                                                                    <Slider.Root
                                                                        className="slider-root"
                                                                        defaultValue={[
                                                                            0,
                                                                        ]}
                                                                        value={[
                                                                            limitCPU,
                                                                        ]}
                                                                        max={1}
                                                                        min={0}
                                                                        step={
                                                                            0.01
                                                                        }
                                                                        onValueChange={(
                                                                            v
                                                                        ) => {
                                                                            setLimitCPU(
                                                                                v[0]
                                                                            );
                                                                        }}
                                                                    >
                                                                        <Slider.Track className="slider-track">
                                                                            <Slider.Range className="slider-range" />
                                                                        </Slider.Track>
                                                                        <Slider.Thumb
                                                                            className="slider-thumb"
                                                                            aria-label="Max utilization"
                                                                        />
                                                                    </Slider.Root>
                                                                    <span className="text-sm">
                                                                        Unlimited
                                                                    </span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </fieldset>

                                                    {/* TODO  <fieldset className="flex flex-col gap-2">
                                                    <label className="Label" htmlFor="bandwidth">
                                                        Limit upload
                                                    </label>
                                                    <input
                                                        className="p-2"
                                                        onChange={(v) => {


                                                        }}
                                                        id="bandwidth"
                                                        type="number"
                                                        placeholder="(MB/s)"
                                                    ></input>
                                                </fieldset> */}
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-4">
                                            <GraphExplorer
                                                log={files.program?.files.log}
                                            />
                                        </div>

                                        <Popover.Close
                                            className="popover-close"
                                            aria-label="Close"
                                        >
                                            <MdClose />
                                        </Popover.Close>
                                        <Popover.Arrow className="popover-arrow" />
                                    </Popover.Content>
                                </Popover.Portal>
                            </Popover.Root>
                        </div>
                        <br />
                        {uploadProgress != null && (
                            <Progress.Root
                                data-testid="upload-progress"
                                className="progress-root w-full h-3"
                                value={uploadProgress}
                            >
                                <Progress.Indicator
                                    className="progress-indicator"
                                    style={{
                                        transform: `translateX(-${
                                            100 - uploadProgress * 100
                                        }%)`,
                                    }}
                                />
                            </Progress.Root>
                        )}
                        {list?.length > 0 ? (
                            <div className="flex justify-start flex-col">
                                <h1 className="text-xl">
                                    Files ({list.length}):
                                </h1>
                                <ul data-testid="file-list">
                                    {list.map((x, ix) => {
                                        return (
                                            <li key={ix}>
                                                <File
                                                    isHost={isHost}
                                                    delete={() => {
                                                        files.program
                                                            .removeById(x.id)
                                                            .then(() => {
                                                                updateList();
                                                            })
                                                            .catch((error) => {
                                                                alert(
                                                                    "Failed to delete: " +
                                                                        error.message
                                                                );
                                                            });
                                                    }}
                                                    download={(progress) =>
                                                        download(x, progress)
                                                    }
                                                    files={files.program}
                                                    file={x}
                                                    replicated={
                                                        role === "replicator" &&
                                                        replicationSet.has(x.id)
                                                    }
                                                />
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ) : (
                            <span className="italic">No files available</span>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};
