import { TbTextResize } from "react-icons/tb";
import { Path } from "./Path";
import * as Toggle from "@radix-ui/react-toggle";

export const Toolbar = (properties: {
    onEditModeChange: (edit: boolean) => void;
}) => {
    return (
        <div className="w-full flex p-2">
            <Path></Path>
            <Toggle.Root
                onPressedChange={(e) => {
                    properties.onEditModeChange(e);
                }}
                className="ml-auto btn-icon btn-icon-md btn-toggle"
                aria-label="Toggle italic"
            >
                <TbTextResize />
            </Toggle.Root>
        </div>
    );
};
