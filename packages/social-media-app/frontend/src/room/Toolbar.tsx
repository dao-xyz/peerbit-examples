import { MdAppRegistration, MdSave } from "react-icons/md";
import { AiOutlineAppstoreAdd } from "react-icons/ai";
import { TbBorderCorners } from "react-icons/tb";
import * as Toggle from "@radix-ui/react-toggle";
import { MdKeyboardArrowDown } from "react-icons/md";
export const Toolbar = (properties: {
    title: string;
    subtitle: string;
    onEditModeChange: (edit: boolean) => void;
    onSave: () => void;
    unsavedCount: number;
    onNew: () => void;
}) => {
    return (
        <div className="w-full flex p-2">
            <button className="mr-2 btn btn-elevated flex flex-row items-center pt-0 pb-0 pl-2 pr-2">
                <div className="flex flex-col place-items-start leading-[15px]">
                    <span>{properties.title}</span>
                    <span className="font-[monospace] text-sx break-all">
                        {properties.subtitle}
                    </span>
                </div>
                <MdKeyboardArrowDown className="ml-1" size={20} />
            </button>
            <Toggle.Root
                onPressedChange={(e) => {
                    properties.onEditModeChange(e);
                }}
                className="ml-auto btn-icon btn-icon-md  btn-toggle mr-1  h-max"
                aria-label="Toggle italic"
            >
                <TbBorderCorners />
            </Toggle.Root>
            <button
                onClick={() => {
                    console.log("SAVE?");
                    properties.onSave();
                }}
                className="btn-elevated btn-icon btn-icon-md btn-toggle mr-1 relative h-max"
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
                className=" btn-elevated btn-icon btn-icon-md btn-toggle h-max"
                aria-label="Toggle italic"
            >
                <AiOutlineAppstoreAdd />
            </button>
        </div>
    );
};
