import { Canvas, Scope } from "@giga-app/interface";
import { PrivateScope, PublicScope } from "../useScope";
import { CanvasHandle } from "../CanvasWrapper";
import { useRef } from "react";
import pDefer from "p-defer";

type UsePublishArgs = {
    canvas: Canvas | undefined;
    canvasHandleRef: React.RefObject<CanvasHandle>;
};

export const usePublish = ({ canvas, canvasHandleRef }: UsePublishArgs) => {
    const privateScope = PrivateScope.useScope().scope as Scope | undefined;
    const publicScope = PublicScope.useScope().scope as Scope | undefined;

    const isSaving = useRef(false);

    /**
     * Persist pending element edits into the PRIVATE scope and ensure there is a
     * PRIVATE link for discoverability while drafting.
     *
     * - If replyTo is provided -> ensure a private reply link exists
     * - Else -> ensure the draft is registered as a private top-level
     */
    const saveDraft = async (replyTo?: Canvas): Promise<void> => {
        if (!canvas) throw new Error("Canvas is not defined");
        if (!privateScope) throw new Error("Private scope is not mounted");

        // 1) write pending rects into the private scope
        const saved = await canvasHandleRef.current?.savePending(privateScope);
        if (!saved || saved.length === 0) {
            // nothing to persist — still ensure draft is registered for discovery
        }

        // 2) ensure discoverability in PRIVATE scope
        if (replyTo) {
            // keep the draft private; just a link in private scope under replyTo
            await replyTo.upsertReply(canvas, {
                type: "link-only",
                visibility: "child", // only in the parent's scope
            });
        } else {
            // top-level private registration (no parent)
            await privateScope.getOrCreateReply(undefined, canvas, {
                visibility: "child", // register in private only
            });
        }
    };

    /**
     * Publish the draft:
     * - If replying: migrate/sync child to PUBLIC scope and link under replyTo
     * - If top-level: register in PUBLIC as a root post
     * - Always remove the private draft copy afterwards
     */
    const publish = async (replyTo?: Canvas): Promise<void> => {
        if (!canvas) throw new Error("Canvas is not defined");
        if (!publicScope) throw new Error("Public scope is not mounted");

        const gate = pDefer<void>();
        isSaving.current = true;

        try {
            // flush any pending edits before promotion
            if (privateScope) {
                await canvasHandleRef.current?.savePending(privateScope);
            }

            if (replyTo) {
                // Promote to PUBLIC by syncing + linking under the reply target
                await replyTo.upsertReply(canvas, {
                    type: "sync",            // move/copy canonical data to targetScope
                    targetScope: publicScope,
                    visibility: "both",      // mirror in parent’s scope as needed
                });
            } else {
                // Publish as PUBLIC top-level (no parent)
                await publicScope.getOrCreateReply(undefined, canvas, {
                    visibility: "both",
                });
            }

            // After successful publish, delete the private draft copy
            if (privateScope) {
                await privateScope.remove(canvas);
            }

            gate.resolve();
        } catch (e) {
            gate.reject(e as Error);
        } finally {
            isSaving.current = false;
        }

        return gate.promise;
    };

    return { saveDraft, publish, isSaving };
};