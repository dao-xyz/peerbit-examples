import { createVariantAdapter, type CanonicalOpenOptions } from "@peerbit/canonical-client";
import type { DocumentsProxy } from "@peerbit/document-proxy/client";
import type { Address, Program } from "@peerbit/program";
import { TodoItem } from "./model";
import { TodoProgram } from "./program";

const toHex = (bytes: Uint8Array): string => {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
};

export type TodoProgramProxy = {
    todos: DocumentsProxy<TodoItem>;
    close: () => Promise<void>;
};

type CanonicalPeer = {
    open: <S extends Program<any>>(
        storeOrAddress: S | Address | string,
        options?: CanonicalOpenOptions<S>
    ) => Promise<any>;
};

export const todoProgramAdapter = createVariantAdapter<TodoProgram, TodoProgramProxy>({
    name: "sharedworker-todo",
    variant: "todo_program",
    getKey: (program) => {
        const id = program.todos?.log?.log?.id;
        if (!id) return;
        return `todo:${toHex(id)}`;
    },
    open: async ({ program, peer }) => {
        // Use a stable "proxy parent" token to attach child proxies without needing
        // to pass the (yet-to-be-managed) outer proxy as parent.
        const parent = {};

        const proxy: TodoProgramProxy = {
            todos: undefined as unknown as DocumentsProxy<TodoItem>,
            close: async () => {
                const todos: any = proxy.todos as any;
                if (!todos || typeof todos.close !== "function") return;
                try {
                    await todos.close(parent);
                } catch {
                    await todos.close().catch(() => {});
                }
            },
        };

        const canonicalPeer = peer as unknown as CanonicalPeer;

        try {
            const todos = (await canonicalPeer.open(program.todos, {
                existing: "reuse",
                parent,
                args: { type: TodoItem },
            })) as DocumentsProxy<TodoItem>;

            proxy.todos = todos;

            // Use the Documents address as the outer program's address for stable identity/debugging.
            const address = (todos as any)?.address;

            return { proxy, address };
        } catch (e) {
            await proxy.close().catch(() => {});
            throw e;
        }
    },
});
