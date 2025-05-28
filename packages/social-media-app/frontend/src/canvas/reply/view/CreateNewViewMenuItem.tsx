import { FaPlus } from "react-icons/fa";
import { useState } from "react";
import { useView } from "./ViewContex";

export const CreateNewViewMenuItem = () => {
    const { createView } = useView();

    /* ───────────── create-new view local state ───────────── */
    const [newName, setNewName] = useState("");
    const [saving, setSaving] = useState(false);

    const handleCreate = async () => {
        if (!newName.trim()) return;
        setSaving(true);
        await createView(newName.trim());
        setNewName("");
        setSaving(false);
    };

    return (
        <div className="px-4 pt-1 pb-2 space-y-2">
            <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New view name"
                className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <button
                disabled={newName.trim().length === 0 || saving}
                onClick={handleCreate}
                className={`w-full flex items-center justify-center gap-2 rounded px-3 py-1.5 text-sm transition ${
                    newName.trim().length === 0 || saving
                        ? "bg-neutral-300 dark:bg-neutral-700 cursor-not-allowed text-neutral-500"
                        : "bg-primary-600 hover:bg-primary-700 text-white"
                }`}
            >
                <FaPlus className="text-xs" />
                Save view
            </button>
        </div>
    );
};
