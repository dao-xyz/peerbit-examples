import React from "react";
import { describe, it, expect, vi } from "vitest";
import * as ReactClient from "react-dom/client";
import {
    DraftSessionProvider,
    useDraftSession,
} from "../canvas/edit/draft/DraftSession";
import { CanvasHandleRegistryContext } from "../canvas/edit/CanvasHandleRegistry";

// ---------- Mocks ----------

// Deterministic randomBytes to see distinct keys
let keyCounter = 10;
vi.mock("@peerbit/crypto", () => ({
    randomBytes: (n: number) =>
        new Uint8Array([++keyCounter, ...new Array(n - 1).fill(0)]),
}));

// Fake DraftManager injected via hook mock
type Canvas = { idString: string };
const mkCanvas = (() => {
    let c = 0;
    return () => ({ idString: `D${++c}` });
})();

function makeFakeMgr() {
    const listeners = new Set<() => void>();
    const records = new Map<string, Canvas>();
    const parentIndex = new Map<string, string>();
    const setReplyCalls: { key: string; parentId?: string }[] = [];

    const toBucket = (key?: Uint8Array) =>
        key ? `b:${Array.from(key).join(",")}` : `b:auto`;

    const api = {
        async ensure(args: any) {
            const bucket = toBucket("key" in args ? args.key : undefined);
            let cur = records.get(bucket);
            if (!cur) {
                cur = mkCanvas();
                records.set(bucket, cur);
            }
            if (args.replyTo) parentIndex.set(args.replyTo.idString, bucket);
            listeners.forEach((l) => l());
            return cur;
        },
        async ensureForParent(parent: any, key?: Uint8Array) {
            const bucket = toBucket(key);
            let cur = records.get(bucket);
            if (!cur) {
                cur = mkCanvas();
                records.set(bucket, cur);
            }
            parentIndex.set(parent.idString, bucket);
            listeners.forEach((l) => l());
            return cur;
        },
        get(key: Uint8Array) {
            return records.get(toBucket(key));
        },
        getForParent(parent: any) {
            const b = parentIndex.get(parent.idString);
            return b ? records.get(b) : undefined;
        },
        setReplyTarget(_key: Uint8Array, c?: any) {
            setReplyCalls.push({ key: toBucket(_key), parentId: c?.idString });
        },
        getReplyTarget(_key: Uint8Array) {
            return undefined;
        },
        async publish(_key: Uint8Array) {},
        saveDebounced(_key: Uint8Array) {},
        async save(_key: Uint8Array) {},
        listActiveIds() {
            return new Set<string>();
        },
        isActiveId(_id: string) {
            return false;
        },
        subscribe(cb: () => void) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        isPublishing() {
            return false;
        },
        isSaving() {
            return false;
        },
        abandon() {
            return Promise.resolve();
        },
        debug: {
            dump() {
                return {};
            },
            clear() {},
        },
    } as any;
    (api as any).__calls = { setReplyCalls };
    return api;
}

const fakeMgr = makeFakeMgr();
vi.mock("../canvas/edit/draft/DraftManager", () => ({
    useDraftManager: () => fakeMgr,
}));

// Private scope needed for publish() flush path; not exercised deeply here
vi.mock("../canvas/useScope", () => ({
    PrivateScope: { useScope: () => ({ address: "priv" }) },
}));

// ---------- Helpers ----------

function renderSession(replyTo: any, onChange: (id?: string) => void) {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = (ReactClient as any).createRoot(div);

    const Observer: React.FC = () => {
        const { draft } = useDraftSession();
        React.useEffect(() => {
            onChange(draft?.idString);
        }, [draft?.idString]);
        return null;
    };

    // Register a fake canvas handle so publish() can call savePending safely
    const handle = { savePending: async () => [] } as any;
    const RegisterHandle: React.FC<any> = ({
        children,
    }: {
        children: React.ReactNode[];
    }) => {
        const registrar = React.useContext(CanvasHandleRegistryContext)!;
        const { draft } = useDraftSession();
        React.useEffect(() => {
            if (draft)
                registrar?.(handle, { canvasId: (draft as any).idString });
        }, [draft, registrar]);
        return <>{children}</>;
    };

    // expose publish through a ref we capture below
    const pubRef: { fn?: () => Promise<void> } = {};
    const CapturePublish: React.FC = () => {
        const { publish } = useDraftSession();
        React.useEffect(() => {
            pubRef.fn = publish;
        }, [publish]);
        return null;
    };

    root.render(
        <DraftSessionProvider replyTo={replyTo}>
            <RegisterHandle>
                <Observer />
                <CapturePublish />
            </RegisterHandle>
        </DraftSessionProvider>
    );

    return {
        root,
        div,
        publish: async () => {
            await pubRef.fn?.();
        },
    };
}

// ---------- Tests ----------

describe("DraftSession", () => {
    it("ensures a draft for parent and rotates on publish, updating reply target for new key", async () => {
        const parent = { idString: "P-DS-1" };
        let seen: string[] = [];
        const session = renderSession(parent, (id) => {
            if (id) seen.push(id);
        });

        // initial ensure
        await new Promise((r) => setTimeout(r, 10));
        expect(seen.length).toBeGreaterThan(0);
        const first = seen[seen.length - 1];

        // call publish on the same session tree
        await session.publish();

        await new Promise((r) => setTimeout(r, 10));
        const after = seen[seen.length - 1];
        expect(after).not.toBe(first);

        // Verify setReplyTarget was called at least twice (initial ensure + post-rotate)
        const calls = (fakeMgr as any).__calls.setReplyCalls as any[];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    // Additional behaviors around subscription + notifications are covered by e2e tests.
});
