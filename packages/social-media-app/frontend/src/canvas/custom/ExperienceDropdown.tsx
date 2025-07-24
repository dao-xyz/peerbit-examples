import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useVisualizationContext } from "./CustomizationProvider";
import { JSX, useEffect, useMemo, useState } from "react";
import { BasicVisualization, ChildVisualization } from "@giga-app/interface";
import { MdAdd, MdOutlineExplore } from "react-icons/md";
import { HiOutlineNewspaper } from "react-icons/hi";
import { MdOutlineAccountTree } from "react-icons/md";
import { IoChatbubblesOutline } from "react-icons/io5";
import { Spinner } from "../../utils/Spinner";

let getExperienceName = (childrenVisualization: ChildVisualization) => {
    if (childrenVisualization === ChildVisualization.FEED) {
        return "Feed";
    }
    if (childrenVisualization === ChildVisualization.TREE) {
        return "Tree";
    }
    if (childrenVisualization === ChildVisualization.EXPLORE) {
        return "Explore";
    }
    if (childrenVisualization === ChildVisualization.CHAT) {
        return "Chat";
    }
};

let getExperienceIcon = (
    childrenVisualization: ChildVisualization
): JSX.Element => {
    if (childrenVisualization === ChildVisualization.FEED) {
        return <HiOutlineNewspaper size={24} />;
    }
    if (childrenVisualization === ChildVisualization.TREE) {
        return <MdOutlineAccountTree size={24} />;
    }
    if (childrenVisualization === ChildVisualization.EXPLORE) {
        return <MdOutlineExplore size={24} />;
    }
    if (childrenVisualization === ChildVisualization.CHAT) {
        return <IoChatbubblesOutline size={24} />;
    }
    return <></>;
};

let experiences = [
    ChildVisualization.FEED,
    ChildVisualization.CHAT,
    ChildVisualization.TREE,
    ChildVisualization.EXPLORE,
];

export const ExperienceDropdownButton = (properties?: {
    className?: string;
}) => {
    const { visualization, updateDraft } = useVisualizationContext();

    let experienceName = useMemo(() => {
        if (visualization?.childrenVisualization == null) {
            return undefined
        }
        return getExperienceName(visualization.childrenVisualization);
    }, [visualization]);

    let experienceIcon = useMemo(() => {
        if (visualization == null) {
            return <></>;
        }
        return getExperienceIcon(visualization.childrenVisualization);
    }, [visualization]);

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    className={
                        "btn btn-icon btn-sm h-full flex flex-row gap-1  " +
                        properties?.className
                    }
                >
                    {experienceIcon}
                    {experienceName ? <span
                        className="text-xl    font-ganja"
                        style={{ lineHeight: 0 }}
                    >
                        {experienceName}
                    </span> : <></>/*  <Spinner /> */}
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
                className="z-10 bg-white dark:bg-neutral-950 p-2 rounded shadow-xl max-h-[unset]"
                style={{ minWidth: "130px" }}
            >
                {experiences.map((exp) => (
                    <DropdownMenu.Item
                        key={exp}
                        className="menu-item"
                        onSelect={() => {
                            console.log(`Switching to ${exp}`);
                            updateDraft(
                                new BasicVisualization({
                                    ...visualization,
                                    childrenVisualization: exp,
                                })
                            );
                        }}
                    >
                        <div className="flex items-center gap-2">
                            {getExperienceIcon(exp)}
                            <span
                                className="text-xl font-ganja"
                                style={{ lineHeight: 0 }}
                            >
                                {getExperienceName(exp)}
                            </span>
                        </div>
                    </DropdownMenu.Item>
                ))}
                <hr className="my-1" />
                <DropdownMenu.Item
                    key={"custom"}
                    className="menu-item my-0 py-0 pb-2"
                    disabled
                >
                    <div className="flex flex-row items-center w-full">
                        <div className="flex flex-col">
                            <span className="text-xl font-ganja text-neutral-500 dark:text-gray-400">
                                Custom
                            </span>
                            <span
                                className="text-sm text-gray-500 dark:text-gray-400 italic "
                                style={{ fontSize: "12px", lineHeight: "5px" }}
                            >
                                Coming soon
                            </span>
                        </div>
                        <MdAdd className="ml-auto dark:text-gray-400" />
                    </div>
                </DropdownMenu.Item>
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    );
};
