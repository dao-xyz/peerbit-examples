import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useRef,
} from "react";
import { usePeer } from "@peerbit/react";
import { AddressReference, Canvas, Scope } from "@giga-app/interface";
import debounce from "lodash/debounce";

import { CanvasHandle } from "../CanvasWrapper";
import { CanvasHandleRegistryContext } from "./CanvasHandleRegistry";
import { usePublish } from "./usePublish";
import { useCanvasPrivateToPublicDifference } from "./useCanvasDifference";
import { useMemoCleanup } from "../../useMemoCleanup";
import { PrivateScope, PublicScope } from "../useScope";

interface PendingCanvasContextType {
    pendingCanvas: Canvas | undefined;
    publish: () => Promise<void>;
    saveDraft: () => Promise<void>;
    saveDraftDebounced: () => void;
    setReplyTo: (canvas: Canvas | undefined) => Promise<void>;
    isSaving: boolean;
    savedOnce?: boolean;
    isEmpty: boolean;
    hasUnpublishedChanges: boolean;
}

const PendingCanvasContext =
    createContext<PendingCanvasContextType | undefined>(undefined);

export const PendingCanvasProvider: React.FC<{
    children: ReactNode;
    /** Optional externally-provided draft */
    pendingCanvas?: Canvas;
    onDraftCreated?: (canvas: Canvas) => void;
    /** Initial reply target (optional) */
    replyTo?: Canvas;
}> = ({ replyTo: initialReplyTo, children, pendingCanvas: fromPendingCanvas, onDraftCreated }) => {
    const { peer } = usePeer();

    // preferred drafting home is the private scope; fall back to public
    const privateScope = PrivateScope.useScope().scope;
    const publicScope = PublicScope.useScope().scope;

    const [pendingCanvasState, setPendingCanvasState] = useState<Canvas | undefined>(undefined);
    const [replyTo, setReplyToState] = useState<Canvas | undefined>(initialReplyTo);

    // keep a stable reference to current reply target for publish()
    const replyToRef = useRef<Canvas | undefined>(initialReplyTo);
    useEffect(() => { replyToRef.current = replyTo; }, [replyTo]);

    const canvasHandleRef = useRef<CanvasHandle | null>(null);
    const registerHandle = (handle: CanvasHandle) => { canvasHandleRef.current = handle; };

    /**
     * Create a brand new draft in the chosen home scope and REGISTER it so it’s
     * recoverable: we place it in the scope replies table at the top-level
     * via `getOrCreateReply(undefined, draft)`. This ensures it’s indexed.
     */
    const createSetNewDraft = async () => {
        if (!peer) return;

        const home: Scope | undefined = privateScope || publicScope;
        // If there is no mounted scope yet, still create an in-memory draft (will be registered later)
        const draft = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: home ? new AddressReference({ address: home.address }) : undefined,
        });

        console.log("REPLY TO ", replyTo)
        // If we have a home scope, register the draft immediately so it’s indexed/recoverable
        let materialized = draft;
        if (home) {
            const [__, created] = await home.getOrCreateReply(replyTo, draft);
            materialized = created; // this is the opened/registered instance in the scope
        }

        setPendingCanvasState(materialized);
        onDraftCreated?.(materialized);
        console.log("Created new draft canvas", materialized.idString, "in scope", home?.address);
    };

    // init/refresh pending draft
    useEffect(() => {
        if (!peer) return;
        let cancelled = false;

        (async () => {
            if (fromPendingCanvas) {
                if (!cancelled) {
                    console.log("Using externally provided pendingCanvas", fromPendingCanvas.idString);
                    setPendingCanvasState(fromPendingCanvas);
                }
                return;
            }

            if (!pendingCanvasState) {
                const c = await createSetNewDraft();
                if (cancelled) return;
            }
        })().catch((e) => console.error("PendingCanvasProvider init error:", e));

        return () => { cancelled = true; };
        // re-run when identity or scopes change or a new external canvas is passed
    }, [
        peer?.identity.publicKey.hashcode(),
        privateScope?.address,
        publicScope?.address,
        fromPendingCanvas?.idString,
    ]);

    // allow callers to update the reply target; no mutation on the Canvas itself
    const setReplyTo = async (newReplyTo?: Canvas) => {
        if (isSaving.current) {
            console.log("setReplyTo while saving; ignoring");
            return;
        }
        setReplyToState(newReplyTo ?? undefined);
    };

    // wire up publish/save hooks
    // NOTE: your usePublish should support publish(replyTo?: Canvas)
    const { publish: _publish, saveDraft, isSaving } = usePublish({
        canvas: pendingCanvasState,
        canvasHandleRef,
    });

    const publish = async () => {
        await saveDraftDebounced.flush?.();
        await _publish(replyToRef.current); // link under the selected parent
        // start a brand new (registered) draft afterwards
        await createSetNewDraft();
    };

    const { diff } = useCanvasPrivateToPublicDifference({ canvas: pendingCanvasState });

    const saveDraftDebounced = useMemoCleanup(
        () => debounce(() => saveDraft(), 120, { leading: false, trailing: true }),
        // depend on stable primitives only
        [saveDraft, pendingCanvasState?.idString, pendingCanvasState?.selfScope?.address],
        (deb) => deb.cancel()
    );

    return (
        <CanvasHandleRegistryContext.Provider value={registerHandle}>
            <PendingCanvasContext.Provider
                value={{
                    pendingCanvas: pendingCanvasState,
                    publish,
                    saveDraft,
                    saveDraftDebounced,
                    setReplyTo,
                    savedOnce: canvasHandleRef.current?.savedOnce,
                    isEmpty: !!canvasHandleRef.current?.isEmpty,
                    isSaving: isSaving.current,
                    hasUnpublishedChanges: diff,
                }}
            >
                {children}
            </PendingCanvasContext.Provider>
        </CanvasHandleRegistryContext.Provider>
    );
};

export const usePendingCanvas = (): PendingCanvasContextType => {
    const ctx = useContext(PendingCanvasContext);
    if (!ctx) throw new Error("usePendingCanvas must be used within a PendingCanvasProvider");
    return ctx;
};