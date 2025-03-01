import { MdAppRegistration, MdSave } from "react-icons/md";
import { AiOutlineAppstoreAdd } from "react-icons/ai";
import { TbBorderCorners } from "react-icons/tb";
import * as Toggle from "@radix-ui/react-toggle";
import { MdKeyboardArrowDown } from "react-icons/md";
import { LuGitBranchPlus } from "react-icons/lu";
export const Header = (properties: { title: string; subtitle: string }) => {
    return (
        <div className="w-full flex p-2">
            {/*  <button className="mr-2 btn btn-elevated flex flex-row items-center pt-0 pb-0 pl-2 pr-2">
                <div className="flex flex-col place-items-start leading-[15px]">
                    <span>{properties.title}</span>
                    <span className="font-[monospace] text-sx break-all">
                        {properties.subtitle}
                    </span>
                </div>
                <MdKeyboardArrowDown className="ml-1" size={20} />
            </button> */}
            <div className="flex flex-row pt-0 pb-0 pl-2 pr-2">
                <div className="flex flex-col place-items-start justify-center">
                    <span>{properties.title}</span>
                    <span className="font-[monospace] text-xs break-all">
                        {properties.subtitle}
                    </span>
                </div>
            </div>
        </div>
    );
};
