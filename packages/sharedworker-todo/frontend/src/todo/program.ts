import { field, variant } from "@dao-xyz/borsh";
import { Documents } from "@peerbit/document";
import { Program } from "@peerbit/program";
import { TodoItem } from "./model";

@variant("todo_program")
export class TodoProgram extends Program {
    @field({ type: Documents })
    todos: Documents<TodoItem>;

    constructor(properties: { id: Uint8Array }) {
        super();
        this.todos = new Documents<TodoItem>({ id: properties.id });
    }

    async open(): Promise<void> {
        await this.todos.open({
            type: TodoItem,
            replicate: { factor: 1 },
        });
    }
}
