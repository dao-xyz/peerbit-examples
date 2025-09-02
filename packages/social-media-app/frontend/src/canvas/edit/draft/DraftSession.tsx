import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { Canvas, IndexableCanvas } from "@giga-app/interface";
import type { WithIndexedContext } from "@peerbit/document";
import { randomBytes } from "@peerbit/crypto";
import { useDraftManager } from "./DraftManager";
import { PrivateScope } from "../../useScope";
import {
    CanvasHandleRegistryContext,
    Registrar,
} from "../CanvasHandleRegistry";

export type CanvasIx = WithIndexedContext<Canvas, IndexableCanvas>;
export type CanvasKey = Uint8Array;

type DraftSession = {
    draft?: CanvasIx;
    publish: () => Promise<void>;
    saveDebounced: () => void;
    setReplyTarget: (c?: CanvasIx) => void;
    getReplyTarget: () => CanvasIx | undefined;
    isPublishing: boolean;
    isSaving: boolean;
};

const DraftSessionCtx = createContext<DraftSession | undefined>(undefined);

export const useDraftSession = () => {
    const ctx = useContext(DraftSessionCtx);
    if (!ctx)
        throw new Error(
            "useDraftSession must be used within DraftSessionProvider"
        );
    return ctx;
};

export const DraftSessionProvider: React.FC<{
    children: React.ReactNode;
    replyTo: CanvasIx;
    keyish?: CanvasKey;
}> = ({ children, replyTo, keyish }) => {
    const mgr = useDraftManager();

    // One key per *parent* (replyTo). We rotate it when parent changes.
    const keyRef = useRef<CanvasKey | undefined>(keyish);
    const prevParentRef = useRef<string | undefined>(undefined);

    const [draft, _setDraft] = useState<CanvasIx | undefined>(undefined);

    // capture handle for flushing UI edits
    const handleRef = useRef<{
        savePending: (scope: unknown) => Promise<unknown>;
    } | null>(null);

    // drafts live in the private scope
    const privateScope = PrivateScope.useScope();

    const expectedIdRef = useRef<string | undefined>(undefined);

    const setDraft = (d?: CanvasIx) => {
        expectedIdRef.current = d?.idString;
        _setDraft(d);
    };

    // Helper: abandon a bucket/key safely (supports old manager without .abandon)
    const abandon = (k?: CanvasKey) => {
        if (!k) return;
        if (typeof (mgr as any).abandon === "function") {
            (mgr as any).abandon(k);
        } else if (mgr.debug?.clear) {
            mgr.debug.clear(k);
        }
    };

    // Ensure/recover for this *parent*; rotate key on parent change.
    useEffect(() => {
        const pid = replyTo?.idString;
        if (!pid) return;

        // If parent changed, abandon previous bucket and rotate key
        if (prevParentRef.current && prevParentRef.current !== pid) {
            abandon(keyRef.current);
            keyRef.current = undefined;
            setDraft(undefined);
        }

        if (!keyRef.current) {
            keyRef.current = keyish ?? randomBytes(32);
        }

        prevParentRef.current = pid;

        let cancelled = false;
        (async () => {
            const ensured = await mgr.ensure({ replyTo, key: keyRef.current! });
            if (!cancelled) {
                setDraft(ensured);
                mgr.setReplyTarget(keyRef.current!, replyTo);
            }
        })().catch(console.error);

        return () => {
            cancelled = true;
        };
        // rotate when the parent canvas changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [replyTo?.idString]);

    // SUBSCRIBE to manager changes so we swap to the freshly-rotated draft immediately
    useEffect(() => {
        const unsub = mgr.subscribe(() => {
            const k = keyRef.current;
            if (!k) return;
            const current = mgr.get(k);
            if (!current) return;
            setDraft(current);
        });
        return unsub;
    }, [mgr]);

    // Cleanup on unmount: abandon current key to avoid late promises resurrecting it
    useEffect(() => {
        return () => {
            abandon(keyRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // publish: flush UI → save → rotate (manager notifies; subscription updates draft)
    const publish = async () => {
        const k = keyRef.current!;
        try {
            await handleRef.current!.savePending(privateScope);
            await mgr.save(k);
        } catch (error) {
            console.error("Failed to publish draft", error);
        } finally {
            await mgr.publish(k);
            // No need to setDraft here; subscription above handles rotation asap.
        }
    };

    const saveDebounced = () => {
        const k = keyRef.current!;
        mgr.saveDebounced(k);
    };

    const setReplyTarget = (c?: CanvasIx) => {
        const k = keyRef.current!;
        mgr.setReplyTarget(k, c);
    };

    const getReplyTarget = () => {
        const k = keyRef.current!;
        return mgr.getReplyTarget(k);
    };

    const isPublishing = keyRef.current
        ? mgr.isPublishing?.(keyRef.current) ?? false
        : false;
    const isSaving = keyRef.current
        ? mgr.isSaving?.(keyRef.current) ?? false
        : false;

    const value = useMemo(
        () => ({
            draft,
            publish,
            saveDebounced,
            setReplyTarget,
            getReplyTarget,
            isPublishing,
            isSaving,
        }),
        [draft, isPublishing, handleRef.current, isSaving]
    );

    const registrar = useCallback<Registrar>((h, meta) => {
        // only accept registration for the *current draft* canvas
        if (meta.canvasId && meta.canvasId === expectedIdRef.current) {
            handleRef.current = h;
            return () => {
                if (handleRef.current === h) handleRef.current = null;
            };
        }
        return () => {};
    }, []);

    return (
        <DraftSessionCtx.Provider value={value}>
            <CanvasHandleRegistryContext.Provider value={registrar}>
                {children}
            </CanvasHandleRegistryContext.Provider>
        </DraftSessionCtx.Provider>
    );
};
