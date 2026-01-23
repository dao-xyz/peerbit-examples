import React from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { useQuery } from "@peerbit/document-react";
import { Sort } from "@peerbit/indexer-interface";
import { TODO_STORE_ID, TodoItem } from "../todo/model";
import { TodoProgram } from "../todo/program";
import type { TodoProgramProxy } from "../todo/adapter";

export const App = () => {
    const peerCtx = usePeer();
    const [text, setText] = React.useState("");
    const todoTemplate = React.useMemo(() => new TodoProgram({ id: TODO_STORE_ID }), []);
    const todosQuery = React.useMemo(
        () => ({
            query: [],
            sort: [
                new Sort({ key: "updatedAt", direction: "desc" }),
                new Sort({ key: "id", direction: "asc" }),
            ],
        }),
        []
    );

    const {
        program: todo,
        status: todoStatus,
        error: todoError,
    } = useProgram<any>(peerCtx.peer, todoTemplate);

    const todoProxy = todo as unknown as TodoProgramProxy | undefined;
    const docsProxy = todoProxy?.todos;

    const { items: todos, isLoading: todosLoading } = useQuery(
        docsProxy,
        {
            query: todosQuery,
            resolve: true,
            local: true,
            remote: false,
            updates: { merge: true },
            batchSize: 250,
        }
    );

    const onAdd = async () => {
        const docs = docsProxy;
        const value = text.trim();
        if (!docs || !value) return;
        setText("");
        const now = BigInt(Date.now());
        const todo = new TodoItem({
            id: crypto.randomUUID(),
            text: value,
            completed: false,
            createdAt: now,
            updatedAt: now,
        });
        await docs.put(todo);
    };

    const onToggle = async (todo: TodoItem) => {
        const docs = docsProxy;
        if (!docs) return;
        const updated = new TodoItem({
            id: todo.id,
            text: todo.text,
            completed: !todo.completed,
            createdAt: todo.createdAt,
            updatedAt: BigInt(Date.now()),
        });
        await docs.put(updated);
    };

    const onRemove = async (todo: TodoItem) => {
        const docs = docsProxy;
        if (!docs) return;
        await docs.del(todo.id);
    };

    const onClearCompleted = async () => {
        const docs = docsProxy;
        if (!docs) return;
        await Promise.all(
            todos.filter((t) => t.completed).map((t) => docs.del(t.id))
        );
    };

    const peerId = peerCtx.peer ? peerCtx.peer.peerId.toString() : undefined;
    const overallError = peerCtx.error?.message ?? todoError?.message;
    const ready =
        peerCtx.status === "connected" &&
        !!docsProxy &&
        todoStatus === "ready" &&
        !todosLoading;
    const todosStatus = !docsProxy ? "idle" : todosLoading ? "loading" : "ready";

    return (
        <div className="page">
            <header className="header">
                <div>
                    <div className="title">SharedWorker Todo</div>
                    <div className="subtitle">
                        Canonical peer in SharedWorker + Documents proxy
                    </div>
                </div>
                <div className="right">
                    <button
                        className="btn"
                        onClick={() => window.open(window.location.href, "_blank")}
                    >
                        Open new tab
                    </button>
                </div>
            </header>

            <section className="card">
                <div className="row">
                    <div className="label">Status</div>
                    <div className="value">
                        peer {peerCtx.loading ? "connecting" : peerCtx.status} ·
                        store {todoStatus} · todos {todosStatus}
                        {peerId ? <span className="muted"> · peerId {peerId}</span> : null}
                    </div>
                </div>
                {overallError ? <div className="error">{overallError}</div> : null}
            </section>

            <section className="card">
                <form
                    className="row"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void onAdd();
                    }}
                >
                    <input
                        className="input"
                        value={text}
                        placeholder="Add a todo…"
                        onChange={(e) => setText(e.target.value)}
                        disabled={!ready}
                    />
                    <button className="btn primary" type="submit" disabled={!ready}>
                        Add
                    </button>
                </form>

                <div className="list">
                    {todos.length === 0 ? (
                        <div className="muted">No todos yet.</div>
                    ) : (
                        todos.map((todo) => (
                            <div key={todo.id} className="todo">
                                <label className="todoLeft">
                                    <input
                                        type="checkbox"
                                        checked={todo.completed}
                                        onChange={() => void onToggle(todo)}
                                    />
                                    <span className={todo.completed ? "done" : ""}>
                                        {todo.text}
                                    </span>
                                </label>
                                <button className="btn danger" onClick={() => void onRemove(todo)}>
                                    Delete
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="row footer">
                    <div className="muted">
                        {todos.filter((t) => !t.completed).length} active ·{" "}
                        {todos.filter((t) => t.completed).length} completed
                    </div>
                    <button className="btn" onClick={() => void onClearCompleted()} disabled={!ready}>
                        Clear completed
                    </button>
                </div>
            </section>
        </div>
    );
};
