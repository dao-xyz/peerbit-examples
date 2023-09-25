import { MdAppRegistration, MdSave } from "react-icons/md";
import { AiOutlineAppstoreAdd } from "react-icons/ai";
import { TbBorderCorners } from "react-icons/tb";
import * as Toggle from "@radix-ui/react-toggle";
import { MdKeyboardArrowDown } from "react-icons/md";
import { LuGitBranchPlus, LuMessageSquarePlus } from "react-icons/lu";
import { TbMessageCirclePlus, TbHomePlus } from "react-icons/tb";
import { BsSendPlus } from "react-icons/bs";
export const ToolbarVertical = (properties: {
    onSave: () => void;
    unsavedCount: number;
    onNew: () => void;
    onEditModeChange?: (edit: boolean) => void;
}) => {
    return (
        <div className="flex flex-col p-2 gap-2 mt-auto">
            {/*        <Toggle.Root
                onPressedChange={(e) => {
                    properties.onEditModeChange(e);
                }}
                className="ml-auto btn-icon btn-icon-md  btn-toggle h-max"
                aria-label="Toggle italic"
            >
                <TbBorderCorners />
            </Toggle.Root> */}
            <button
                onClick={() => {
                    console.log("SAVE?");
                    properties.onSave();
                }}
                className="ml-auto btn btn-elevated btn-icon btn-icon-md btn-toggle relative h-max"
                aria-label="Toggle italic"
            >
                <MdSave />
                {properties.unsavedCount > 0 && (
                    <div className="absolute outline outline-2 h-5 w-5 top-[-4px] right-[-8px] bg-primary-400/50 outline-primary-400 dark:bg-primary-400/50 dark:outline-primary-200   text-sm rounded-full">
                        {properties.unsavedCount}
                    </div>
                )}
            </button>

            <button
                onClick={() => {
                    console.log("NEW");
                    properties.onNew();
                }}
                className="btn btn-elevated btn-icon btn-icon-md btn-toggle h-max"
                aria-label="Toggle italic"
            >
                <BsSendPlus />
            </button>
        </div>
    );
};
