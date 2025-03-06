import { MdSave } from "react-icons/md";
import { TbBorderCorners } from "react-icons/tb";
import * as Toggle from "@radix-ui/react-toggle";
import { MdAdd } from "react-icons/md";
import { AppSelect } from "./AppSelect";
import { SimpleWebManifest } from "@dao-xyz/app-service";

export const CanvasModifyToolbar = (properties: {
    canvas?: boolean;
    unsavedCount: number;
    onNew: (app?: SimpleWebManifest) => void;
    onEditModeChange: (edit: boolean) => void;
    direction?: "row" | "col";
}) => {
    const canvasControls = () => {
        if (properties.canvas) {
            return (
                <>
                    <Toggle.Root
                        onPressedChange={(e) => {
                            properties.onEditModeChange(e);
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
                        {properties.unsavedCount > 0 && (
                            <div className="absolute outline outline-2 h-5 w-5 top-[-4px] right-[-8px] bg-primary-400/50 outline-primary-400 dark:bg-primary-400/50 dark:outline-primary-200   text-sm rounded-full">
                                {properties.unsavedCount}
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
            className={`flex flex-row items-center p-2 gap-2 w-full  ${
                properties.direction === "col" ? "flex-col" : "flex-row"
            }`}
        >
            {canvasControls()}
            <button
                onClick={() => {
                    console.log("NEW");
                    properties.onNew();
                }}
                className=" btn-elevated btn-icon btn-icon-md btn-toggle h-max"
                aria-label="Toggle italic"
            >
                <MdAdd />
            </button>
            <div>
                <AppSelect onSelected={(app) => properties.onNew(app)} />
            </div>
        </div>
    );
};
