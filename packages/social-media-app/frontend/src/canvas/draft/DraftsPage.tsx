import { Canvas, LOWEST_QUALITY } from "@giga-app/interface";
import { CanvasWrapper } from "../CanvasWrapper";
import { CanvasPreview } from "../render/preview/Preview";
import { useDrafts } from "./useDrafts";
import { MdClear } from "react-icons/md";
import { useState } from "react";

export const Drafts = () => {
    const {
        drafts,
        deleteDraft: _deleteDraft,
        deleteAllDrafts: _deleteAllDrafts,
    } = useDrafts();
    const [loading, setLoading] = useState(false);
    const deleteDraft = async (
        draft: Canvas,
        setLoadingState: boolean = true
    ) => {
        setLoadingState && setLoading(true);
        try {
            await _deleteDraft(draft);
        } catch (error) {
            console.error("Error deleting draft:", error);
        } finally {
            setLoadingState && setLoading(false);
        }
    };

    const deleteAllDrafts = async () => {
        setLoading(true);
        try {
            await deleteAllDrafts();
        } catch (error) {
            console.error("Error deleting all drafts:", error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col gap-2 pt-4 px-2">
            <h1>Drafts</h1>
            <div className="flex flex-row">
                <span>You have {drafts.length} drafts</span>
                <button
                    className="btn btn-sm ml-auto"
                    onClick={deleteAllDrafts}
                >
                    Delete all
                </button>
            </div>
            <hr />
            {drafts.map((draft) => (
                <div key={draft.idString} className="flex flex-col gap-2">
                    <div className="flex flex-col">
                        <div className="flex flex-row items-center gap-2">
                            <span className="text-sm">
                                {new Date(
                                    Number(draft.__context.modified) / 1e6
                                ).toLocaleDateString()}
                            </span>

                            {/* Delete button */}
                            <button
                                className="btn btn-sm  ml-auto gap-2"
                                onClick={() => deleteDraft(draft)}
                            >
                                <span>Delete</span>
                                <MdClear />
                            </button>
                        </div>

                        <div className="p-4 bg-neutral-200 dark:bg-neutral-700 rounded-xl btn">
                            <CanvasWrapper
                                canvas={draft}
                                quality={LOWEST_QUALITY}
                            >
                                <CanvasPreview
                                    className="w-full"
                                    variant="row"
                                    whenEmpty={
                                        <span className="italic">
                                            Empty post
                                        </span>
                                    }
                                ></CanvasPreview>
                            </CanvasWrapper>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};
