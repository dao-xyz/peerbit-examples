import { field, variant } from "@dao-xyz/borsh";
import { sha256Sync } from "@peerbit/crypto";

export const TODO_STORE_ID = sha256Sync(
    new TextEncoder().encode("peerbit-examples:canonical-todo:v1")
);

@variant("todo_item")
export class TodoItem {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    text: string;

    @field({ type: "bool" })
    completed: boolean;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "u64" })
    updatedAt: bigint;

    constructor(properties: {
        id: string;
        text: string;
        completed: boolean;
        createdAt: bigint;
        updatedAt: bigint;
    }) {
        this.id = properties.id;
        this.text = properties.text;
        this.completed = properties.completed;
        this.createdAt = properties.createdAt;
        this.updatedAt = properties.updatedAt;
    }
}
