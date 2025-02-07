import { useRef, useState, useEffect } from "react";
import * as Slider from "@radix-ui/react-slider";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import {
    MdPlayArrow,
    MdPause,
    MdChevronLeft,
    MdVideoSettings,
    MdTune,
    MdSlowMotionVideo,
    MdVolumeUp,
    MdVolumeOff,
    MdReplay10,
    MdFullscreen,
    MdCheck,
} from "react-icons/md";
import { ControlInterface } from "./controls";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
} from "./../../controls/settings.js";
import "./../../controls/Controls.css";
import { ReplicationRangeVisualization } from "../../controls/ReplicatorDensity";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import { PublicSignKey } from "@peerbit/crypto";

export const Controls = (
    props: {
        publicKey: PublicSignKey;
        resolutionOptions: Resolution[];
        replicationRanges: ReplicationRangeIndexable<"u64">[];
        selectedResolution?: Resolution[];
        onStreamTypeChange?: (settings: StreamType) => void;
        onQualityChange: (settings: SourceSetting[]) => void;
        viewRef: HTMLCanvasElement;
    } & ControlInterface
) => {
    const [showControls, setShowControls] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(false);
    const [prevMuteVolume, setPrevMuteVolume] = useState(1);
    const [volume, setVolume] = useState(0.66);
    const [isPlaying, setIsPlaying] = useState(props.isPlaying ?? false);

    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >(props.selectedResolution || []);

    // State to manage menu navigation
    const [menuStack, setMenuStack] = useState<string[]>(["main"]);

    // Reference to the controls div
    const controlRef = useRef<HTMLDivElement>(null);

    const togglePlay = () => {
        const isPlayingNow = !isPlaying;
        isPlayingNow ? props.play() : props.pause();
        setIsPlaying(isPlayingNow);
    };

    useEffect(() => {
        if (!props.viewRef) {
            return;
        }

        const handleMouseEnter = () => {
            setShowControls(true);
        };

        const handleMouseLeave = (e: MouseEvent) => {
            if (
                controlRef.current &&
                !controlRef.current.contains(e.relatedTarget as Node)
            ) {
                setShowControls(false);
            }
        };

        props.viewRef.addEventListener("mouseenter", handleMouseEnter);
        props.viewRef.addEventListener("mouseleave", handleMouseLeave);

        return () => {
            props.viewRef.removeEventListener("mouseenter", handleMouseEnter);
            props.viewRef.removeEventListener("mouseleave", handleMouseLeave);
        };
    }, [props.viewRef]);

    useEffect(() => {
        if (!controlRef.current) {
            return;
        }

        const handleMouseEnter = () => {
            setShowControls(true);
        };

        const handleMouseLeave = (e: MouseEvent) => {
            if (
                props.viewRef &&
                !props.viewRef.contains(e.relatedTarget as Node)
            ) {
                setShowControls(false);
            }
        };

        controlRef.current.addEventListener("mouseenter", handleMouseEnter);
        controlRef.current.addEventListener("mouseleave", handleMouseLeave);

        return () => {
            controlRef.current?.removeEventListener(
                "mouseenter",
                handleMouseEnter
            );
            controlRef.current?.removeEventListener(
                "mouseleave",
                handleMouseLeave
            );
        };
    }, [controlRef.current]);

    useEffect(() => {
        const handleDocumentClick = (e: MouseEvent) => {
            if (
                props.viewRef &&
                !props.viewRef.contains(e.target as Node) &&
                controlRef.current &&
                !controlRef.current.contains(e.target as Node)
            ) {
                setShowControls(false);
            }
        };

        document.addEventListener("click", handleDocumentClick);

        return () => {
            document.removeEventListener("click", handleDocumentClick);
        };
    }, [props.viewRef, controlRef.current]);

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

    const toggleMute = () => {
        if (!muted) {
            setPrevMuteVolume(volume);
            props.setVolume(0.0000001);
            props.mute();
        } else {
            props.setVolume(prevMuteVolume);
            props.unmute();
        }
        setMuted(!muted);
    };

    const setNewVolume = (value: number) => {
        setPrevMuteVolume(value);
        setVolume(value);
        props.setVolume(value);
    };

    useEffect(() => {
        let compatibleResolutions = selectedResolutions.filter((x) =>
            props.resolutionOptions.includes(x)
        );
        if (compatibleResolutions.length !== selectedResolutions.length) {
            if (compatibleResolutions.length > 0) {
                setSelectedResolutions(compatibleResolutions);
            } else {
                setSelectedResolutions(
                    props.resolutionOptions.length > 0
                        ? [props.resolutionOptions[0]]
                        : []
                );
            }
        }
    }, [props.resolutionOptions]);

    const handleResolutionChange = (resolution: Resolution) => {
        let newResolutions = [...selectedResolutions];
        const index = newResolutions.indexOf(resolution);
        if (index !== -1) {
            if (newResolutions.length === 1) {
                return; // don't allow to unselect all!
            }
            newResolutions.splice(index, 1);
        } else {
            newResolutions = [resolution];
        }
        newResolutions.sort();

        let change =
            JSON.stringify(newResolutions) !==
            JSON.stringify(selectedResolutions);

        setSelectedResolutions(newResolutions);

        if (change) {
            props.onQualityChange(
                newResolutions.map((x) => resolutionToSourceSetting(x))
            );
        }
    };

    // Helper function to format time
    const formatTime = (timeInMillisecond: number): string => {
        const totalSeconds = Math.floor(timeInMillisecond / 1e3);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
                .toString()
                .padStart(2, "0")}`;
        } else {
            return `${minutes}:${seconds.toString().padStart(2, "0")}`;
        }
    };

    return (
        <div
            ref={controlRef}
            className={`controls flex flex-col ${
                showControls ? "opacity-100" : "opacity-0"
            }`}
        >
            {/* Progress Bar */}
            <div
                className="flex justify-center w-full"
                style={{ marginTop: "-3px" }} // Adjust as needed to align with top of control bar
            >
                <Slider.Root
                    className="relative flex items-center select-none touch-none w-full h-1 group"
                    value={[
                        props.progress === "live"
                            ? 1
                            : props.currentTime / props.maxTime || 0,
                    ]}
                    min={0}
                    max={1}
                    step={0.001}
                    onValueChange={(value) => {
                        const p = value[0];
                        props.setProgress(p);
                    }}
                >
                    <ReplicationRangeVisualization
                        maxTime={props.maxTime}
                        ranges={props.replicationRanges}
                        publicKey={props.publicKey}
                    />

                    <Slider.Track className="bg-gray-200 opacity-50 relative flex-grow rounded-full h-full group-hover:h-2 group-hover:opacity-80 transition-all">
                        <Slider.Range className="absolute bg-primary-500 rounded-full h-full" />
                    </Slider.Track>
                    <Slider.Thumb className="block w-3 h-3 bg-primary-500 rounded-full group-hover:scale-125 transition-transform" />
                </Slider.Root>
            </div>

            {/* Control Bar */}
            <div className="flex items-center justify-between w-full px-2">
                {/* Left Controls */}
                <div className="flex items-center">
                    {/* Play/Pause Button */}
                    <button onClick={togglePlay} className="p-1">
                        {!props.isPlaying ? (
                            <MdPlayArrow size={20} />
                        ) : (
                            <MdPause size={20} />
                        )}
                    </button>

                    {/* Live Button */}
                    <button
                        onClick={() => props.setProgress("live")}
                        className="pl-2 pr-2 text-gray-800 flex items-center justify-center"
                    >
                        {props.progress === "live" ? (
                            <span className="text-primary-500 text-xs font-bold  text-center ">
                                Live
                            </span>
                        ) : (
                            <span className="text-xs  text-center ">Live</span>
                        )}
                    </button>

                    {/* Time Display */}
                    <div className="font-mono text-xs min-w-[70px] text-center">
                        {props.progress !== "live" &&
                            `${formatTime(props.currentTime)}/`}
                        {formatTime(props.maxTime)}
                    </div>

                    {/* Rewind 10 seconds Button */}
                    <button
                        onClick={() => {
                            props.setProgress(
                                Math.max(
                                    (props.currentTime - 10 * 1e3) /
                                        props.maxTime,
                                    0
                                )
                            );
                        }}
                        className="p-1"
                    >
                        <MdReplay10 size={20} />
                    </button>

                    {/* Mute Button */}
                    {props.mute && (
                        <button onClick={toggleMute} className="p-1">
                            {muted ? (
                                <MdVolumeOff size={20} />
                            ) : (
                                <MdVolumeUp size={20} />
                            )}
                        </button>
                    )}
                </div>

                {/* Right Controls */}
                <div className="flex items-center">
                    {/* Fullscreen Button */}
                    {(props.viewRef?.requestFullscreen ||
                        props.viewRef?.["webkitExitFullscreen"]) && (
                        <button
                            onClick={() => {
                                if (props.viewRef) {
                                    if (props.viewRef.requestFullscreen) {
                                        props.viewRef.requestFullscreen();
                                    } else if (
                                        props.viewRef["webkitExitFullscreen"]
                                    ) {
                                        props.viewRef["webkitExitFullscreen"]();
                                    }
                                }
                            }}
                            className="p-1"
                        >
                            <MdFullscreen size={20} />
                        </button>
                    )}

                    {/* Settings Menu */}
                    <DropdownMenu.Root
                        onOpenChange={(open) => {
                            if (!open) {
                                setMenuStack(["main"]); // Reset to main menu when closed
                            }
                        }}
                    >
                        <DropdownMenu.Trigger asChild>
                            <button className="p-1">
                                <MdVideoSettings size={20} />
                            </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                className="bg-white dark:bg-gray-800 shadow-lg rounded p-2 w-64"
                                sideOffset={5}
                                side="top"
                                align="end"
                            >
                                {currentMenu !== "main" && (
                                    <button
                                        onClick={goBack}
                                        className="flex items-center p-2 mb-2"
                                    >
                                        <MdChevronLeft
                                            size={16}
                                            className="mr-2"
                                        />
                                        <span>Back</span>
                                    </button>
                                )}

                                {/* Main Menu */}
                                {currentMenu === "main" && (
                                    <>
                                        <DropdownMenu.Item
                                            onSelect={(event) => {
                                                event.preventDefault();
                                                goToSubmenu("playbackRate");
                                            }}
                                            className="menu-item"
                                        >
                                            <div className="flex items-center">
                                                <MdSlowMotionVideo
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Playback Rate</span>
                                            </div>
                                        </DropdownMenu.Item>

                                        <DropdownMenu.Item
                                            onSelect={(event) => {
                                                event.preventDefault();
                                                goToSubmenu("quality");
                                            }}
                                            className="menu-item"
                                        >
                                            <div className="flex items-center">
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
                                            </div>
                                        </DropdownMenu.Item>
                                    </>
                                )}

                                {/* Playback Rate Submenu */}
                                {currentMenu === "playbackRate" && (
                                    <div className="flex flex-col">
                                        <div className="flex items-center">
                                            <MdSlowMotionVideo
                                                size={16}
                                                className="mr-2"
                                            />
                                            <span>Playback Rate</span>
                                        </div>
                                        <Select.Root
                                            value={String(speed)}
                                            onValueChange={(value) => {
                                                setSpeed(Number(value));
                                                props.setSpeed(Number(value));
                                            }}
                                        >
                                            <Select.Trigger className="ml-auto flex items-center">
                                                <Select.Value />
                                                <Select.Icon />
                                            </Select.Trigger>
                                            <Select.Content>
                                                <Select.Viewport>
                                                    <Select.Item value="0.5">
                                                        <Select.ItemText>
                                                            0.5x
                                                        </Select.ItemText>
                                                    </Select.Item>
                                                    <Select.Item value="1">
                                                        <Select.ItemText>
                                                            1x
                                                        </Select.ItemText>
                                                    </Select.Item>
                                                    <Select.Item value="1.25">
                                                        <Select.ItemText>
                                                            1.25x
                                                        </Select.ItemText>
                                                    </Select.Item>
                                                    <Select.Item value="2">
                                                        <Select.ItemText>
                                                            2x
                                                        </Select.ItemText>
                                                    </Select.Item>
                                                </Select.Viewport>
                                            </Select.Content>
                                        </Select.Root>
                                    </div>
                                )}

                                {/* Quality Submenu */}
                                {currentMenu === "quality" && (
                                    <>
                                        {props.resolutionOptions.map(
                                            (resolution) => (
                                                <DropdownMenu.Item
                                                    key={resolution}
                                                    onSelect={(event) => {
                                                        event.preventDefault();
                                                        handleResolutionChange(
                                                            resolution
                                                        );
                                                    }}
                                                    className="menu-item"
                                                >
                                                    <div className="flex items-center">
                                                        <span>
                                                            {resolution}p
                                                        </span>
                                                        {selectedResolutions.includes(
                                                            resolution
                                                        ) && (
                                                            <MdCheck
                                                                size={16}
                                                                className="ml-auto"
                                                            />
                                                        )}
                                                    </div>
                                                </DropdownMenu.Item>
                                            )
                                        )}
                                    </>
                                )}
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                </div>
            </div>
        </div>
    );
};
