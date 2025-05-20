import { StreamType } from "../../controls/settings";
import {
    MdOndemandVideo,
    MdPresentToAll,
    MdTvOff,
    MdVideoCameraFront,
} from "react-icons/md";
import { useEffect, useState } from "react";
import { MediaSelect } from "./MediaSelect";

export const FirstMenuSelect = (props: {
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
        <div className="flex flex-col gap-2">
            <button
                onClick={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "camera",
                    });
                }}
                className="btn flex"
            >
                <div className="flex items-center">
                    <MdVideoCameraFront size={16} className="mr-2" />
                    <span>Camera</span>
                </div>
            </button>
            <button
                onClick={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "screen",
                    });
                }}
                className="btn"
            >
                <div className="flex items-center">
                    <MdPresentToAll size={16} className="mr-2" />
                    <span>Screen</span>
                </div>
            </button>
            <button
                onClick={(event) => {
                    event.preventDefault();
                    document.getElementById("media-file-select-xxx")!.click();
                }}
                className="btn"
            >
                <div className="flex items-center">
                    <MdOndemandVideo size={16} className="mr-2" />
                    <span>Video</span>
                </div>
            </button>
            <MediaSelect
                id="media-file-select-xxx"
                handleSourceTypeChange={handleSourceTypeChange}
            />

            <button
                onClick={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "noise",
                    });
                }}
                className="btn"
            >
                <div className="flex items-center">
                    <MdTvOff size={16} className="mr-2" />
                    <span>Noise</span>
                </div>
            </button>

            <button
                onClick={(event) => {
                    event.preventDefault();
                    handleSourceTypeChange({
                        type: "demo",
                    });
                }}
                className="btn"
            >
                <div className="flex items-center">
                    <MdTvOff size={16} className="mr-2" />
                    <span>Demo</span>
                </div>
            </button>
        </div>
    );
};
