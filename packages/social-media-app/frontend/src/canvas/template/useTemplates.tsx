/**********************************************************************
 * useTemplates.tsx
 *********************************************************************/
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePeer, useProgram, useQuery } from "@peerbit/react";
import { sha256Sync, randomBytes } from "@peerbit/crypto";
import {
    Template,
    Templates, // the Program class from template.ts
    IndexableTemplate,
    createAlbumTemplate,
    createProfileTemplate,
    createCommunityTemplate,
    createPlaylistTemplate,
} from "@giga-app/interface"; // ← adjust path if needed

import { Canvas } from "@giga-app/interface";

/* ------------------------------------------------------------------ */
/* A deterministic ID for the Templates program                       */
const TEMPLATES_ID = sha256Sync(new TextEncoder().encode("giga‑templates"));

/* ------------------------------------------------------------------ */
export type UseTemplatesReturn = {
    /** All templates (live). */
    templates: Template[];
    /** While initial load is running. */
    loading: boolean;
    /** Insert template subtree under the given parent canvas. */
    insert(template: Template, into: Canvas): Promise<Canvas>;
    /** Add or overwrite a template. */
    put(template: Template): Promise<any>;
    /** Delete by id. */
    del(id: Uint8Array): Promise<any>;

    /** Case‑insensitive in‑memory search over name + description. */
    search(query: string): Promise<Template[]>;
};

/* ------------------------------------------------------------------ */
export function useTemplates(): UseTemplatesReturn {
    const { peer } = usePeer();

    const [bootstrapped, setBootstrapped] = useState(false);

    /* 1️⃣  Open (or create) the Templates program once ---------------- */
    const useProgramResult = useProgram(new Templates(TEMPLATES_ID), {
        existing: "reuse",
    });
    const prog = useProgramResult?.program as Templates | undefined;

    /* 2️⃣  Ensure default templates exist (runs only once) ------------ */
    useEffect(() => {
        if (!prog || bootstrapped) return;

        prog.templates.events.addEventListener("change", (ev) => {
            return console.log("TEMPLATES CHANGE", ev);
        });

        (async () => {
            const ensure = async (tpl: Template) => {
                if (
                    !(await prog.templates.index.get(tpl.id, {
                        local: true,
                        remote: { eager: true },
                    }))
                ) {
                    console.log("PUT TEMPLATE", tpl, prog.templates.address);
                    await prog.templates.put(tpl);
                } else {
                    console.log(
                        "GOT TEMPLATE",
                        (await prog.templates.index.iterate().all()).length
                    );
                }
            };
            console.log("CREATE TEMPLATES");
            /* await ensure(
                 await createAlbumTemplate({ peer, name: "Photo album" })
             );
               await ensure(
                  await createProfileTemplate({ peer, name: "Personal profile" })
              );
              await ensure(
                  await createCommunityTemplate({ peer, name: "Community" })
              );
              await ensure(
                  await createPlaylistTemplate({ peer, name: "Music playlist" })
              );
   */
            setBootstrapped(true);
        })();
    }, [prog, bootstrapped, peer]);

    /* 3️⃣  Live collection of templates -------------------------------- */
    const { items: templates, isLoading: queryLoading } = useQuery<
        Template,
        IndexableTemplate
    >(prog?.templates, {
        id: prog?.templates.address,
        query: useMemo(() => {
            return {};
        }, []),
        local: true,
        remote: { eager: true, joining: { waitFor: 5e3 } },
        onChange: {
            merge: true,
        },
        prefetch: false,
    });

    /* 4️⃣  Utility helpers -------------------------------------------- */
    const put = useCallback(
        async (tpl: Template) => prog?.templates.put(tpl),
        [prog]
    );

    const del = useCallback(
        async (id: Uint8Array) => prog?.templates.del(id),
        [prog]
    );

    const insert = useCallback(async (tpl: Template, into: Canvas) => {
        if (!tpl || !into) throw new Error("Missing args");
        console.log("Insert template", tpl, "into", into.address.toString());
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
        [useProgramResult?.program]
    );

    /* 5️⃣  Return API -------------------------------------------------- */
    return useMemo<UseTemplatesReturn>(
        () => ({
            templates,
            loading: queryLoading || !bootstrapped || !prog,
            insert,
            put,
            del,
            search,
        }),
        [templates, queryLoading, bootstrapped, prog, insert, put, del]
    );
}
