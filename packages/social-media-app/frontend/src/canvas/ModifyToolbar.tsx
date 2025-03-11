import { MdSave } from "react-icons/md";
import { TbBorderCorners } from "react-icons/tb";
import * as Toggle from "@radix-ui/react-toggle";
import { VscDebug } from "react-icons/vsc";

import { AppSelect } from "./AppSelect";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { useCanvas } from "./CanvasWrapper";
import { ImageUploadTrigger } from "../content/native/image/ImageUploadToCanvas";
import { DebugGeneratePostButton } from "./DebugGeneratePostButton";

const isLocal = import.meta.env.MODE === "development";

export const CanvasModifyToolbar = (properties: {
    canvas?: boolean;
    direction?: "row" | "col";
}) => {
    const { setEditMode, pendingRects, insertDefault } = useCanvas();
    const onNew = (app: SimpleWebManifest) =>
        insertDefault({ app, increment: true });
    const unsavedCount = pendingRects.length;
    const canvasControls = () => {
        if (properties.canvas) {
            return (
                <>
                    <Toggle.Root
                        onPressedChange={(e) => {
                            setEditMode(e);
                        }}
                        className="ml-auto btn-icon btn-icon-md  btn-toggle h-max"
                        aria-label="Toggle italic"
                    >
                        <TbBorderCorners />
                    </Toggle.Root>
                    {/*  <button
                        onClick={() => {
                            console.log("SAVE?");
                            properties.onSave();
                        }}
                        className="ml-auto btn-elevated btn-icon btn-icon-md btn-toggle relative h-max"
                        aria-label="Toggle italic"
                    >
                        <MdSave />
                        {unsavedCount > 0 && (
                            <div className="absolute outline outline-2 h-5 w-5 top-[-4px] right-[-8px] bg-primary-400/50 outline-primary-400 dark:bg-primary-400/50 dark:outline-primary-200   text-sm rounded-full">
                                {unsavedCount}
                            </div>
                        )}
                    </button> */}
                </>
            );
        }
        return <></>;
    };

    return (
        <div
            className={`flex flex-row items-center gap-2 w-full  ${
                properties.direction === "col" ? "flex-col" : "flex-row"
            }`}
        >
            {canvasControls()}
            {/*   <button
                onClick={() => {
                    console.log("NEW");
                    properties.onNew();
                }}
                className=" btn-elevated btn-icon btn-icon-md btn-toggle h-max"
                aria-label="Toggle italic"
            >
                <MdAdd />
            </button> */}
            <ImageUploadTrigger />
            {isLocal && <DebugGeneratePostButton />}
            <div className="w-[40px] h-[40px]">
                <AppSelect onSelected={(app) => onNew(app)} />
            </div>
        </div>
    );
};
