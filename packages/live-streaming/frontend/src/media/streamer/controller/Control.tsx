import { useState, useEffect, useCallback, useRef } from "react";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixSlider from "@radix-ui/react-slider";
import {
    MdPlayArrow,
    MdPause,
    MdChevronLeft,
    MdVideoSettings,
    MdTune,
    MdStream,
    MdFullscreen,
    MdVolumeUp,
    MdVolumeOff,
    MdUpload,
} from "react-icons/md";
import {
    SourceSetting,
    StreamType,
    Resolution,
} from "../../controls/settings.js";
import "./../../controls/Controls.css";
import useVideoPlayer from "./useVideoPlayer.js";
import { Spinner } from "../../../utils/Spinner.js";
import { MediaStreamDB } from "./../../database.js";
import { SourceSelect } from "./MenuSourceSelect.js";
import { ResolutionSelect } from "./ResolutionSelect.js";
import { useLocation } from "react-router-dom";
import { TimeSlider } from "../../controls/TimeSlider.js";

export const Controls = (props: {
    resolutionOptions: Resolution[];
    selectedResolution?: Resolution[];
    sourceType: StreamType | undefined;
    setSourceType?: (settings: StreamType | undefined) => void;
    onQualityChange: (settings: SourceSetting[]) => void;
    onVolumeChange?: (volume: number) => void;
    videoRef?: HTMLVideoElement;
    viewRef?: HTMLCanvasElement | HTMLVideoElement;
    alwaysShow: boolean | undefined;
    muted?: boolean;
    mediaStreams?: MediaStreamDB;
}) => {
    const [showControls, setShowControls] = useState(props.alwaysShow || false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [muted, setMuted] = useState(props.muted ?? false);
    const [prevMuteVolume, setPrevMuteVolume] = useState(1);
    const [volume, setVolume] = useState(1);
    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >(props.selectedResolution || []);

    const [menuStack, setMenuStack] = useState<string[]>(["main"]);

    const controls = useVideoPlayer(props.videoRef);

    const { search } = useLocation();
    const searchParams = new URLSearchParams(search);
    const sourceParam = searchParams.get("source");
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!sourceParam) {
            return;
        }

        if (!props?.mediaStreams?.address) {
            return; // not ready yet
        }

        // based on the source param we want to do certain calls like upload media
        let newType: StreamType | undefined = undefined;
        if (
            sourceParam === "noise" ||
            sourceParam === "demo" ||
            sourceParam === "camera" ||
            sourceParam === "screen"
        ) {
            newType = { type: sourceParam };
        } else if (sourceParam === "upload-media" && fileInputRef.current) {
            throw new Error("Not supported");
        }

        if (newType) {
            props.setSourceType(newType);
        }
    }, [sourceParam, props?.mediaStreams?.address, fileInputRef.current]);

    const togglePlay = () => {
        const isPlayingNow = !controls.isPlaying;
        isPlayingNow ? controls.play() : controls.pause();
    };

    const toggleMute = () => {
        if (!muted) {
            setPrevMuteVolume(volume);
            controls.setVolume(0.0000001);
            controls.mute();
            props.onVolumeChange?.(0);
        } else {
            controls.setVolume(prevMuteVolume);
            controls.unmute();
            props.onVolumeChange?.(prevMuteVolume);
        }
        setMuted(!muted);
    };

    const setNewVolume = (value: number) => {
        setPrevMuteVolume(value);
        setVolume(value);
        controls.setVolume(value);
    };

    const goToSubmenu = (menu: string) => {
        setMenuStack((prevStack) => [...prevStack, menu]);
    };

    const goBack = () => {
        setMenuStack((prevStack) => {
            if (prevStack.length > 1) {
                return prevStack.slice(0, -1);
            }
            return prevStack;
        });
    };

    const currentMenu = menuStack[menuStack.length - 1];

    const controlRef = useCallback(
        (node) => {
            if (props.alwaysShow) {
                return;
            }
            if (node) {
                addShowControlsListener(node);
            }
        },
        [isMenuOpen]
    );

    const addShowControlsListener = (ref: HTMLElement) => {
        ref.addEventListener("mouseover", () => {
            setShowControls(true);
        });
        ref.addEventListener("mouseleave", () => {
            if (!isMenuOpen && !props.alwaysShow) {
                setShowControls(false);
            }
        });
    };

    useEffect(() => {
        if (!props.viewRef || props.alwaysShow) {
            return;
        }
        addShowControlsListener(props.viewRef);
    }, [props.viewRef, props.alwaysShow, isMenuOpen]);

    useEffect(() => {
        setSelectedResolutions(props.selectedResolution || []);
    }, [props.selectedResolution]);

    const resolvePlayIcon = () => {
        if (
            props.sourceType?.type === "upload-media" ||
            props.sourceType?.type === "demo"
        ) {
            return <MdUpload size={24} />;
        }
        return <MdPlayArrow size={24} />;
    };

    const resolvePauseIcon = () => {
        if (
            props.sourceType?.type === "upload-media" ||
            props.sourceType?.type === "demo"
        ) {
            return <Spinner size={24} />;
        }
        return <MdPause size={24} />;
    };

    return (
        <>
            <div
                ref={controlRef}
                className={`controls flex flex-col ${
                    showControls ? "opacity-100" : "opacity-0"
                }`}
            >
                {/* if stream type is not set, also show video controls in the center of the screen where the videoRef is taking it place */}
                {props.videoRef && (
                    <TimeSlider
                        currentTime={props.videoRef.currentTime * 1e3}
                        maxTime={props.videoRef.duration * 1e3}
                        mediaStreamsDB={props.mediaStreams}
                        progress={0}
                        setProgress={() => {}}
                    ></TimeSlider>
                )}

                <div className="flex items-center justify-center w-full">
                    <div className="flex justify-center">
                        <button onClick={togglePlay} className="p-2">
                            {!controls.isPlaying
                                ? resolvePlayIcon()
                                : resolvePauseIcon()}
                        </button>
                    </div>
                    {controls.mute && (
                        <div id="volume-button" className="flex justify-center">
                            <button onClick={toggleMute} className="p-2">
                                {muted ? (
                                    <MdVolumeOff size={24} />
                                ) : (
                                    <MdVolumeUp size={24} />
                                )}
                            </button>
                        </div>
                    )}
                    {controls.setVolume && (
                        <div
                            id="volume-slider"
                            className="flex justify-center w-[75px] pl-1"
                            style={{ display: "none" }}
                        >
                            <RadixSlider.Root
                                className="relative flex items-center select-none touch-none w-full h-5"
                                value={[volume]}
                                max={1}
                                step={0.005}
                                onValueChange={(value) =>
                                    setNewVolume(value[0])
                                }
                            >
                                <RadixSlider.Track className="bg-gray-200 relative flex-grow rounded-full h-1">
                                    <RadixSlider.Range className="absolute bg-blue-500 rounded-full h-full" />
                                </RadixSlider.Track>
                                <RadixSlider.Thumb className="block w-3 h-3 bg-blue-500 rounded-full" />
                            </RadixSlider.Root>
                        </div>
                    )}
                    <div className="ml-auto">
                        <RadixMenu.Root
                            onOpenChange={(open) => {
                                setIsMenuOpen(open);
                                if (open) {
                                    setShowControls(true);
                                } else {
                                    !props.alwaysShow && setShowControls(false);
                                    setMenuStack(["main"]); // Reset menu stack when menu closes
                                }
                            }}
                        >
                            <RadixMenu.Trigger asChild>
                                <button className="p-2">
                                    <MdVideoSettings size={24} />
                                </button>
                            </RadixMenu.Trigger>
                            <RadixMenu.Portal>
                                <RadixMenu.Content
                                    className="bg-white dark:bg-gray-800 shadow-lg rounded w-48"
                                    sideOffset={5}
                                    side="top"
                                    align="end"
                                >
                                    {currentMenu !== "main" && (
                                        <button
                                            onClick={goBack}
                                            className="menu-item"
                                        >
                                            <MdChevronLeft
                                                size={16}
                                                className="mr-2"
                                            />
                                            <span>Back</span>
                                        </button>
                                    )}
                                    {currentMenu === "main" && (
                                        <>
                                            <RadixMenu.Item
                                                onSelect={(event) => {
                                                    event.preventDefault(); // Prevent menu from closing
                                                    goToSubmenu("source");
                                                }}
                                                className="menu-item"
                                            >
                                                <div className="flex items-center">
                                                    <MdStream
                                                        size={16}
                                                        className="mr-2"
                                                    />
                                                    <span>Source</span>
                                                </div>
                                            </RadixMenu.Item>
                                            <RadixMenu.Item
                                                onSelect={(event) => {
                                                    event.preventDefault();
                                                    goToSubmenu("quality");
                                                }}
                                                className="menu-item"
                                            >
                                                <MdTune
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Quality</span>
                                                <span className="ml-auto text-sm text-gray-500">
                                                    {selectedResolutions.length >
                                                    2
                                                        ? `${
                                                              selectedResolutions[0]
                                                          }p, ${
                                                              selectedResolutions[1]
                                                          }p, (+${
                                                              selectedResolutions.length -
                                                              2
                                                          })`
                                                        : selectedResolutions
                                                              .map(
                                                                  (x) => x + "p"
                                                              )
                                                              .join(", ")}
                                                </span>
                                            </RadixMenu.Item>
                                        </>
                                    )}
                                    {currentMenu === "source" && (
                                        <SourceSelect
                                            setSourceType={props.setSourceType}
                                            sourceType={props.sourceType}
                                        />
                                    )}
                                    {currentMenu === "quality" && (
                                        <ResolutionSelect
                                            selectedResolutions={
                                                selectedResolutions
                                            }
                                            setSelectedResolutions={
                                                setSelectedResolutions
                                            }
                                            resolutionOptions={
                                                props.resolutionOptions
                                            }
                                            onQualityChange={
                                                props.onQualityChange
                                            }
                                        />
                                    )}
                                </RadixMenu.Content>
                            </RadixMenu.Portal>
                        </RadixMenu.Root>
                    </div>

                    {(props.videoRef?.requestFullscreen ||
                        props.videoRef?.["webkitExitFullscreen"]) && (
                        <div className="flex justify-center">
                            <button
                                onClick={() => {
                                    if (props.videoRef.requestFullscreen) {
                                        props.videoRef.requestFullscreen();
                                    } else if (
                                        props.videoRef["webkitExitFullscreen"]
                                    ) {
                                        props.videoRef[
                                            "webkitExitFullscreen"
                                        ]();
                                    }
                                }}
                                className="p-2"
                            >
                                <MdFullscreen size={24} />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};
