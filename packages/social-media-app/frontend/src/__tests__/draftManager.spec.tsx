import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    DraftManagerProvider,
    useDraftManager,
} from "../canvas/edit/draft/DraftManager";
import { DebugConfigProvider } from "../debug/DebugConfig";
import * as ReactClient from "react-dom/client";

// -------------------- Mocks --------------------

// Mock peer
vi.mock("@peerbit/react", () => ({
    usePeer: () => ({
        peer: {
            identity: {
                publicKey: {
                    bytes: new Uint8Array([1, 2, 3]),
                    equals: () => true,
                    hashcode: () => "pk",
                },
            },
        },
    }),
}));

// Minimal Canvas + helpers
vi.mock("@giga-app/interface", () => {
    let canvasCounter = 0;
    class FakeCanvas {
        id: Uint8Array;
        idString: string;
        nearestScope: any;
        constructor(opts: any) {
            this.id = opts?.id ?? new Uint8Array([0]);
            this.idString = `C${++canvasCounter}`;
            this.nearestScope = {
                remove: async () => {},
                _hierarchicalReindex: { flush: async (_: any) => {} },
            };
        }
        static createIdString(key: Uint8Array) {
            return `B:${Array.from(key).join(",")}`;
        }
        async isEmpty() {
            return false;
        }
        async countOwnedElements() {
            return 0;
        }
    }
    return {
        Canvas: FakeCanvas,
        ReplyKind: class {},
        AddressReference: class {
            constructor(_: any) {}
        },
        getImmediateRepliesQuery: (_p: any) => ({} as any),
        getOwnedElementsQuery: (_p: any) => ({} as any),
        IndexableCanvas: class {},
    };
});

// Private/Public scope minimal stubs
vi.mock("../canvas/useScope", () => {
    const privateScope = {
        address: "private-scope",
        replies: { index: { iterate: () => ({ all: async () => [] }) } },
        openWithSameSettings: async (p: any) => p,
        getOrCreateReply: async (_replyTo: any, draft: any, _opts: any) => [
            true,
            {
                getSelfIndexedCoerced: async () => draft,
            },
        ],
        elements: { index: { iterate: () => ({ all: async () => [] }) } },
        _hierarchicalReindex: { flush: async () => {} },
    } as any;
    const publicScope = {
        address: "public-scope",
        elements: { index: {} },
    } as any;
    return {
        PrivateScope: { useScope: () => privateScope },
        PublicScope: { useScope: () => publicScope },
    };
});

// -------------------- Helpers --------------------

function renderWithManager(onReady: (mgr: any) => void) {
    const div = document.createElement("div");
    document.body.appendChild(div);

    const Probe: React.FC = () => {
        const mgr = useDraftManager();
        React.useEffect(() => {
            onReady(mgr);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [mgr]);
        return null;
    };

    const root = (ReactClient as any).createRoot(div);
    root.render(
        <DebugConfigProvider>
            <DraftManagerProvider>
                <Probe />
            </DraftManagerProvider>
        </DebugConfigProvider>
    );
    return { root, div };
}

const key = (n: number) => new Uint8Array([n]);

// -------------------- Tests --------------------

describe("DraftManager.ensureForParent honors requested key for existing parent", () => {
    let cleanup: (() => void) | null = null;
    beforeEach(() => {
        cleanup?.();
        cleanup = null;
    });

    it("re-maps parent to requested bucket when different (reuse existing record)", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = { idString: "P1" };

                    // 1) Create initial mapping with keyA
                    const keyA = key(1);
                    const draftA = await mgr.ensureForParent(parent, keyA);
                    expect(draftA).toBeTruthy();
                    const gotA = mgr.getForParent(parent);
                    expect(gotA?.idString).toBe(draftA.idString);

                    // 2) Pre-create a record for requested bucket B (without linking to parent)
                    const keyB = key(2);
                    const onlyB = await mgr.ensure({ key: keyB });
                    expect(onlyB).toBeTruthy();

                    // 3) Ask ensureForParent with keyB → should reuse B and re-point parentIndex
                    const picked = await mgr.ensureForParent(parent, keyB);
                    expect(picked.idString).toBe(onlyB.idString);

                    const now = mgr.getForParent(parent);
                    expect(now?.idString).toBe(onlyB.idString);

                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });

    it("creates a fresh draft under requested bucket when none exists", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = { idString: "P2" };
                    const keyA = key(3);
                    const first = await mgr.ensureForParent(parent, keyA);
                    const before = first.idString;

                    const keyB = key(4);
                    const second = await mgr.ensureForParent(parent, keyB);
                    expect(second.idString).not.toBe(before);
                    const now = mgr.getForParent(parent);
                    expect(now?.idString).toBe(second.idString);
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });
});

describe("DraftManager publish/flags/abandon", () => {
    it("publish rotates draft and toggles isPublishing", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = {
                        idString: "P3",
                        nearestScope: {
                            _hierarchicalReindex: { flush: async () => {} },
                        },
                        upsertReply: async () => {},
                    };
                    const keyA = key(10);
                    const first = await mgr.ensureForParent(parent, keyA);
                    const firstId = first.idString;

                    await mgr.publish(keyA);
                    expect(mgr.isPublishing(keyA)).toBe(false);

                    const after = mgr.getForParent(parent);
                    expect(after?.idString).not.toBe(firstId);
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });

    it("abandon removes mappings and records", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = { idString: "P4" };
                    const k = key(11);
                    await mgr.ensureForParent(parent, k);
                    expect(mgr.getForParent(parent)).toBeTruthy();
                    await mgr.abandon(k);
                    expect(mgr.getForParent(parent)).toBeUndefined();
                    expect(mgr.get(k)).toBeUndefined();
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });

    it("listActiveIds includes retired old id shortly after publish", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = {
                        idString: "P5",
                        nearestScope: {
                            _hierarchicalReindex: { flush: async () => {} },
                        },
                        upsertReply: async () => {},
                    };
                    const k = key(12);
                    const first = await mgr.ensureForParent(parent, k);
                    const oldId = first.idString;
                    await mgr.publish(k);
                    const now = mgr.getForParent(parent)!;
                    const all = mgr.listActiveIds();
                    expect(all.has(now.idString)).toBe(true);
                    expect(all.has(oldId)).toBe(true); // still in retiring window
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });

    it("subscribe notifies on ensure, publish, abandon", async () => {
        await new Promise<void>((resolve, reject) => {
            try {
                renderWithManager(async (mgr) => {
                    const parent: any = {
                        idString: "P6",
                        nearestScope: {
                            _hierarchicalReindex: { flush: async () => {} },
                        },
                        upsertReply: async () => {},
                    };
                    let ticks = 0;
                    const unsub = mgr.subscribe(() => ticks++);
                    const k = key(13);
                    await mgr.ensureForParent(parent, k);
                    await mgr.publish(k);
                    await mgr.abandon(k);
                    unsub();
                    expect(ticks).toBeGreaterThanOrEqual(3);
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });
});
