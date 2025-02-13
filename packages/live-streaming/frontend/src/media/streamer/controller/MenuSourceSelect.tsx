import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { StreamType } from "../../controls/settings";
import {
    MdCheck,
    MdOndemandVideo,
    MdPresentToAll,
    MdTvOff,
    MdVideoCameraFront,
} from "react-icons/md";
import { useEffect, useState } from "react";
import { MediaSelect } from "./MediaSelect";

export const SourceSelect = (props: {
    sourceType: StreamType | undefined;
    setSourceType: (type: StreamType | undefined) => void;
}) => {
    const [prevSettings, setPrevSettings] = useState<StreamType>(
        props.sourceType
    );

    const handleSourceTypeChange = (type: StreamType) => {
        const currentJSON = JSON.stringify(type);
        if (currentJSON !== JSON.stringify(prevSettings)) {
            setPrevSettings(JSON.parse(currentJSON));
            props.setSourceType(type);
        }
    };

    useEffect(() => {
        setPrevSettings(props.sourceType);
    }, [props.sourceType]);

    return (
        <>
            <RadixMenu.Item
                onSelect={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "camera",
                    });
                }}
                className="menu-item"
            >
                <div className="flex items-center">
                    <MdVideoCameraFront size={16} className="mr-2" />
                    <span>Camera</span>
                    {props.sourceType?.type === "camera" && (
                        <MdCheck size={16} className="ml-auto" />
                    )}
                </div>
            </RadixMenu.Item>
            <RadixMenu.Item
                onSelect={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "screen",
                    });
                }}
                className="menu-item"
            >
                <div className="flex items-center">
                    <MdPresentToAll size={16} className="mr-2" />
                    <span>Screen</span>
                    {props.sourceType?.type === "screen" && (
                        <MdCheck size={16} className="ml-auto" />
                    )}
                </div>
            </RadixMenu.Item>
            <RadixMenu.Item
                onSelect={(event) => {
                    event.preventDefault();
                    document.getElementById("media-file-select")?.click();
                }}
                className="menu-item"
            >
                <div className="flex items-center">
                    <MdOndemandVideo size={16} className="mr-2" />
                    <span>Video</span>
                    <MediaSelect
                        handleSourceTypeChange={handleSourceTypeChange}
                    />
                    {props.sourceType?.type === "upload-media" && (
                        <MdCheck size={16} className="ml-auto" />
                    )}
                </div>
            </RadixMenu.Item>

            <RadixMenu.Item
                onSelect={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "noise",
                    });
                }}
                className="menu-item"
            >
                <div className="flex items-center">
                    <MdTvOff size={16} className="mr-2" />
                    <span>Noise</span>
                    {props.sourceType?.type === "noise" && (
                        <MdCheck size={16} className="ml-auto" />
                    )}
                </div>
            </RadixMenu.Item>
        </>
    );
};
