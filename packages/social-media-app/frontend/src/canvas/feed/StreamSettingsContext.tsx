import React, { createContext, useContext, useMemo } from "react";
import { usePeer, useProgram, useQuery } from "@peerbit/react";
import {
    StreamSettings,
    StreamSetting,
    PinnedPosts,
    Canvas,
    AddressReference,
} from "@giga-app/interface";
import { equals } from "uint8arrays";

type Ctx = {
    /** Dynamic settings (custom views) stored for the current feed root */
    dynamicViewItems: StreamSetting[];
    /** Create a new view (setting) scoped to the current feed root */
    createSettings: (name: string, description?: AddressReference) => Promise<StreamSetting>;
    /** Pin a canvas to a given view */
    pinToView: (view: StreamSetting, canvas: Canvas) => Promise<void>;
};

const StreamSettingsCtx = createContext<Ctx | undefined>(undefined);

export const useStreamSettings = () => {
    const v = useContext(StreamSettingsCtx);
    if (!v) throw new Error("useStreamSettings must be used within a StreamSettingsProvider");
    return v;
};

/**
 * Provider that derives the feed root from useCanvases() (leaf),
 * opens the StreamSettings DB for that canvas, and exposes
 * dynamic view items + helper APIs.
 */
export const StreamSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { peer } = usePeer()
    const program = useProgram(
        useMemo(
            () =>
                peer
                    ? new StreamSettings({ publicKey: peer.identity.publicKey })
                    : undefined,
            [peer]
        ),
        { existing: "reuse", keepOpenOnUnmount: true }
    );

    const { items: dynamicViewItems } = useQuery(program.program?.settings, {
        query: useMemo(() => ({}), []),
        onChange: { merge: true },
        prefetch: true,
        local: true,
        remote: { eager: true, joining: { waitFor: 5e3 } },
    });

    const createSettings = async (name: string, description?: AddressReference) => {
        if (!program.program) throw new Error("StreamSettings program not ready");
        const setting = new StreamSetting({
            id: name,
            description,
        });
        await program.program.settings.put(setting);
        return setting;
    };

    const pinToView = async (view: StreamSetting, canvas: Canvas) => {
        if (!program.program) throw new Error("StreamSettings program not ready");
        if (!view.filter) {
            view.filter = new PinnedPosts({ pinned: [] });
        } else if (view.filter instanceof PinnedPosts === false) {
            throw new Error("View filter is not a PinnedPosts filter, cannot pin to view");
        }
        const pinnedPosts = view.filter as PinnedPosts;
        if (pinnedPosts.pinned.some((p) => equals(p, canvas.id))) return;
        pinnedPosts.pinned.push(canvas.id);
        await program.program.settings.put(view);
    };

    const value = useMemo<Ctx>(
        () => ({
            dynamicViewItems: dynamicViewItems ?? [],
            createSettings,
            pinToView,
        }),
        [dynamicViewItems]
    );

    return <StreamSettingsCtx.Provider value={value}>{children}</StreamSettingsCtx.Provider>;
};