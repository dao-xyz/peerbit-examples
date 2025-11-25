/**********************************************************************
 * useTemplates.tsx
 *********************************************************************/
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@peerbit/document-react";
import { usePeer, useProgram } from "@peerbit/react";
import { sha256Sync } from "@peerbit/crypto";
import {
    Template,
    Templates, // Templates Program (stores Template docs)
    IndexableTemplate,
    createAlbumTemplate,
    createProfileTemplate,
    createCommunityTemplate,
    createPlaylistTemplate,
    createArticleTemplate,
    Scope,
    Canvas, // Canvas model (for insertInto)
} from "@giga-app/interface";

/* ------------------------------------------------------------------ */
/* Deterministic ID/seed for the Templates scope & program            */
const TEMPLATES_ID = sha256Sync(new TextEncoder().encode("giga-templates"));

/* ------------------------------------------------------------------ */
export type UseTemplatesReturn = {
    /** All templates (live). */
    templates: Template[];
    /** While initial load is running. */
    loading: boolean;
    /** Insert template subtree under the given parent canvas. */
    insert(template: Template, into: Canvas): Promise<Canvas>;
    /** Add or overwrite a template. */
    put(template: Template): Promise<void>;
    /** Delete by id. */
    del(id: Uint8Array): Promise<void>;

    /** Case-insensitive in-memory search over name + description. */
    search(query: string): Promise<Template[]>;
};

/* Single instance of the Templates program (address derived from TEMPLATES_ID) */
const TEMPLATES_DB = new Templates(TEMPLATES_ID);

/* ------------------------------------------------------------------ */
export function useTemplates(): UseTemplatesReturn {
    const { peer, persisted } = usePeer();

    /** 1) Open the Templates *program* (documents db that stores Template objects) */
    const templatesProgram = useProgram(peer, TEMPLATES_DB, {
        existing: "reuse",
        args: { replicate: persisted },
    });
    const prog = templatesProgram.program as Templates | undefined;

    /** 2) Open a dedicated *Scope* where the template prototypes live (their canvases) */
    const templatesScopeInst = useMemo(
        () =>
            peer
                ? new Scope({
                      // Your Scope ctor expects { publicKey, seed }
                      publicKey: peer.identity.publicKey,
                      seed: TEMPLATES_ID,
                  })
                : undefined,
        [peer?.identity.publicKey.hashcode()]
    );

    const templatesScope = useProgram(peer, templatesScopeInst, {
        existing: "reuse",
        args: { replicate: persisted },
    });

    /** 3) Bootstrap default templates once */
    const [bootstrapped, setBootstrapped] = useState(false);

    useEffect(() => {
        if (!peer) return;
        if (!prog || templatesProgram.loading) return; // program not ready
        if (!templatesScope.program || templatesScope.loading) return; // scope not ready
        if (bootstrapped) return;

        (async () => {
            const ensure = async (tpl: Template) => {
                if (prog.templates.closed) return;
                const exists = await prog.templates.index.get(tpl.id, {
                    local: true,
                    remote: { reach: { eager: true } },
                });
                if (!exists) {
                    await prog.templates.put(tpl);
                }
            };

            // Create default templates with their prototype canvases in templatesScope
            const scope = templatesScope.program;
            await ensure(
                await createAlbumTemplate({ peer, scope, name: "Photo album" })
            );
            await ensure(
                await createProfileTemplate({
                    peer,
                    scope,
                    name: "Personal profile",
                })
            );
            await ensure(
                await createCommunityTemplate({
                    peer,
                    scope,
                    name: "Community",
                })
            );
            await ensure(
                await createArticleTemplate({ peer, scope, name: "Article" })
            );
            await ensure(
                await createPlaylistTemplate({
                    peer,
                    scope,
                    name: "Music playlist",
                })
            );

            setBootstrapped(true);
        })().catch(console.error);
    }, [
        peer?.identity.publicKey.hashcode(),
        prog,
        templatesProgram.loading,
        templatesScope.program,
        templatesScope.loading,
        bootstrapped,
    ]);

    /** 4) Live query of templates */
    const { items: templates, isLoading: queryLoading } = useQuery<
        Template,
        IndexableTemplate
    >(prog?.templates, {
        id: prog?.templates.address,
        query: useMemo(
            () => (templatesProgram.loading ? undefined : {}),
            [templatesProgram.loading]
        ),
        local: true,
        prefetch: true,
        batchSize: 1000,
        remote: { reach: { eager: true }, wait: { timeout: 5_000 } },
        updates: { merge: true },
    });

    /** 5) Mutators and helpers */
    const put = useCallback(
        async (tpl: Template) => {
            if (!prog) throw new Error("Templates program not ready");
            await prog.templates.put(tpl);
        },
        [prog]
    );

    const del = useCallback(
        async (id: Uint8Array) => {
            if (!prog) throw new Error("Templates program not ready");
            await prog.templates.del(id);
        },
        [prog]
    );

    const insert = useCallback(async (tpl: Template, into: Canvas) => {
        if (!tpl) throw new Error("Missing template");
        if (!into) throw new Error("Missing target canvas");
        // Template.prototype.insertInto(parent: Canvas): Promise<Canvas>
        return tpl.insertInto(into);
    }, []);

    const search = useCallback(
        async (q: string): Promise<Template[]> => {
            const s = q.trim().toLowerCase();
            if (!s) return templates;
            return templates.filter(
                (t) =>
                    t.name.toLowerCase().includes(s) ||
                    (t.description ?? "").toLowerCase().includes(s)
            );
        },
        [templates]
    );

    /** 6) Return API */
    const loading =
        queryLoading ||
        templatesProgram.loading ||
        templatesScope.loading ||
        !bootstrapped ||
        !prog;

    return useMemo<UseTemplatesReturn>(
        () => ({
            templates,
            loading,
            insert,
            put,
            del,
            search,
        }),
        [templates, loading, insert, put, del, search]
    );
}
