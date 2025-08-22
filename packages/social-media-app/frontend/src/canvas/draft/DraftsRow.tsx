import { Canvas, IndexableCanvas, LOWEST_QUALITY } from "@giga-app/interface";
import { MdClear } from "react-icons/md";
import { VscCommentDraft } from "react-icons/vsc";
import { CanvasWrapper } from "../CanvasWrapper";
import { CanvasPreview } from "../preview/Preview";
import { IoEnterOutline } from "react-icons/io5";
import { useDrafts } from "./useDrafts";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { WithIndexedContext } from "@peerbit/document";

export const DraftsRow = (properties: { drafts: WithIndexedContext<Canvas, IndexableCanvas>[] }) => {
    const { deleteAllDrafts } = useDrafts();
    const { drafts } = properties;
    const navigate = useNavigate()

    return <div className="flex flex-col ">
        <div className="flex flex-row  items-center mb-1">
            <div className="flex items-center gap-2">
                <VscCommentDraft />
                <span className="text-sm text-neutral-800 dark:text-neutral-200">
                    Pending drafts (
                    {
                        drafts.length
                    }
                    )
                </span>
            </div>
            {/* Delete button */}
            <button
                className="btn btn-sm w-fit p-1 m-1"
                onClick={
                    deleteAllDrafts
                }
            >
                <MdClear />
            </button>
        </div>
        <div className="flex flex-wrap">
            {drafts.map(
                (post) => (
                    <div
                        key={
                            post.idString
                        }
                        onClick={() => {

                            navigate(
                                getCanvasPath(
                                    post
                                ),
                                {}
                            );
                        }}
                    >
                        <CanvasWrapper
                            canvas={
                                post
                            }
                            quality={
                                LOWEST_QUALITY
                            }
                        >
                            <div className="btn flex flex-col m-1 w-fit! max-w-[150px] h-fit! p-2 pt-0 rounded-lg bg-neutral-50 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                                <div className="flex flex-row gap-2 w-full">
                                    <span className="text-xs mr-auto py-1 text-neutral-500 dark:text-neutral-400">
                                        {new Date(
                                            Number(
                                                post
                                                    .__context
                                                    .modified
                                            ) /
                                            1e6
                                        ).toLocaleDateString()}
                                    </span>
                                    <button className="ml-auto cursor-pointer text-sm">
                                        <div className="flex flex-row items-center gap-1">
                                            <span className="text-xs">
                                                Edit
                                            </span>
                                            <IoEnterOutline />
                                        </div>
                                    </button>
                                </div>
                                <CanvasPreview
                                    variant="tiny"
                                    whenEmpty={
                                        <span className="italic">
                                            Empty
                                            post
                                        </span>
                                    }
                                    className="overflow-hidden"
                                ></CanvasPreview>
                            </div>
                        </CanvasWrapper>
                    </div>
                )
            )}
        </div>
    </div>



}