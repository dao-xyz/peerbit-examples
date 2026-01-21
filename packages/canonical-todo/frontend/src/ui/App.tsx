import React from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { Documents } from "@peerbit/document";
import { useQuery } from "@peerbit/document-react";
import { TODO_STORE_ID, TodoItem } from "../shared/todo";
import type { DocumentsProxy } from "@peerbit/document-proxy/client";

export const App = () => {
    const peerCtx = usePeer();
    const [text, setText] = React.useState("");
    const docsTemplate = React.useMemo(
        () => new Documents<TodoItem>({ id: TODO_STORE_ID }),
        []
    );

    const { program: docs, loading: storeLoading, promise: storePromise } =
        useProgram<any>(
            peerCtx.peer,
            peerCtx.peer ? docsTemplate : undefined,
            { args: { type: TodoItem } }
        );

    const docsProxy = docs as unknown as DocumentsProxy<TodoItem> | undefined;

    const [storeError, setStoreError] = React.useState<string | undefined>(
        undefined
    );

    React.useEffect(() => {
        let cancelled = false;
        setStoreError(undefined);
        if (!storePromise) return;
        storePromise.catch((e) => {
            if (cancelled) return;
            setStoreError(e instanceof Error ? e.message : String(e));
        });
        return () => {
            cancelled = true;
        };
    }, [storePromise]);

    const { items: todosRaw, isLoading: todosLoading } = useQuery(
        docsProxy,
        {
            query: { query: [] },
            resolve: true,
            local: true,
            remote: false,
            updates: { merge: true },
            batchSize: 250,
        }
    );

    const todos = React.useMemo(() => {
        const items = [...(todosRaw as TodoItem[])];
        items.sort((a, b) => Number(b.updatedAt - a.updatedAt));
        return items;
    }, [todosRaw]);

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
    const overallError = peerCtx.error?.message ?? storeError;
    const ready =
        peerCtx.status === "connected" &&
        !!docsProxy &&
        !storeLoading &&
        !todosLoading;
    const storeStatus = storeError
        ? "error"
        : storeLoading
          ? "opening"
          : docsProxy
            ? "ready"
            : "idle";
    const todosStatus = !docsProxy ? "idle" : todosLoading ? "loading" : "ready";

    return (
        <div className="page">
            <header className="header">
                <div>
                    <div className="title">Canonical Todo</div>
                    <div className="subtitle">
                        SharedWorker canonical peer + Documents proxy
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
                        store {storeStatus} · todos {todosStatus}
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
