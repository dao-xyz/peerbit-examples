import { useState, useEffect, useCallback } from "react";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixSlider from "@radix-ui/react-slider";
import {
    MdPlayArrow,
    MdPause,
    MdChevronLeft,
    MdVideoSettings,
    MdTune,
    MdStream,
    MdVideoCameraFront,
    MdOndemandVideo,
    MdPresentToAll,
    MdTvOff,
    MdCheck,
    MdFullscreen,
    MdVolumeUp,
    MdVolumeOff,
} from "react-icons/md";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
} from "../../controls/settings.js";
import "./../../controls/Controls.css";
import useVideoPlayer from "./useVideoPlayer.js";

export const Controls = (props: {
    resolutionOptions: Resolution[];
    selectedResolution?: Resolution[];
    onStreamTypeChange?: (settings: StreamType) => void;
    onQualityChange: (settings: SourceSetting[]) => void;
    videoRef: HTMLVideoElement;
    viewRef: HTMLCanvasElement | HTMLVideoElement;
    alwaysShow: boolean | undefined;
    muted?: boolean;
}) => {
    const [showControls, setShowControls] = useState(props.alwaysShow || false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [muted, setMuted] = useState(props.muted ?? false);
    const [prevMuteVolume, setPrevMuteVolume] = useState(1);
    const [volume, setVolume] = useState(1);
    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >(props.selectedResolution || []);
    const [sourceType, setSourceType] = useState<StreamType>({ type: "noise" });
    const [prevSettings, setPrevSettings] = useState<StreamType>({
        type: "noise",
    });
    const [menuStack, setMenuStack] = useState<string[]>(["main"]);

    const controls = useVideoPlayer(props.videoRef);

    const togglePlay = () => {
        const isPlayingNow = !controls.isPlaying;
        isPlayingNow ? controls.play() : controls.pause();
    };

    const toggleMute = () => {
        if (!muted) {
            setPrevMuteVolume(volume);
            controls.setVolume(0.0000001);
            controls.mute();
        } else {
            controls.setVolume(prevMuteVolume);
            controls.unmute();
        }
        setMuted(!muted);
    };

    const setNewVolume = (value: number) => {
        setPrevMuteVolume(value);
        setVolume(value);
        controls.setVolume(value);
    };

    const handleSourceTypeChange = (type: StreamType) => {
        if (!props.onStreamTypeChange) {
            return;
        }
        const currentJSON = JSON.stringify(type);
        if (currentJSON !== JSON.stringify(prevSettings)) {
            setPrevSettings(JSON.parse(currentJSON));
            props.onStreamTypeChange(type);
        }
        setSourceType(type);
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
            if (node) addShowControlsListener(node);
        },
        [isMenuOpen]
    );

    const addShowControlsListener = (ref: HTMLElement) => {
        ref.addEventListener("mouseover", () => {
            setShowControls(true);
        });
        ref.addEventListener("mouseleave", () => {
            if (!isMenuOpen) {
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

    return (
        <div
            ref={controlRef}
            className={`controls flex flex-col ${
                showControls ? "opacity-100" : "opacity-0"
            }`}
        >
            <div className="flex items-center justify-center w-full">
                <div className="flex justify-center">
                    <button onClick={togglePlay} className="p-2">
                        {!controls.isPlaying ? (
                            <MdPlayArrow size={24} />
                        ) : (
                            <MdPause size={24} />
                        )}
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
                            onValueChange={(value) => setNewVolume(value[0])}
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
                                setShowControls(false);
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
                                                {selectedResolutions.length > 2
                                                    ? `${
                                                          selectedResolutions[0]
                                                      }p, ${
                                                          selectedResolutions[1]
                                                      }p, (+${
                                                          selectedResolutions.length -
                                                          2
                                                      })`
                                                    : selectedResolutions
                                                          .map((x) => x + "p")
                                                          .join(", ")}
                                            </span>
                                        </RadixMenu.Item>
                                    </>
                                )}
                                {currentMenu === "source" && (
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
                                                <MdVideoCameraFront
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Camera</span>
                                                {sourceType.type ===
                                                    "camera" && (
                                                    <MdCheck
                                                        size={16}
                                                        className="ml-auto"
                                                    />
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
                                                <MdPresentToAll
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Screen</span>
                                                {sourceType.type ===
                                                    "screen" && (
                                                    <MdCheck
                                                        size={16}
                                                        className="ml-auto"
                                                    />
                                                )}
                                            </div>
                                        </RadixMenu.Item>
                                        <RadixMenu.Item
                                            onSelect={(event) => {
                                                event.preventDefault();
                                                document
                                                    .getElementById(
                                                        "media-file-select"
                                                    )
                                                    ?.click();
                                            }}
                                            className="menu-item"
                                        >
                                            <div className="flex items-center">
                                                <MdOndemandVideo
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Media</span>
                                                <input
                                                    id="media-file-select"
                                                    hidden
                                                    accept="video/*"
                                                    multiple
                                                    type="file"
                                                    onClick={(event) => {
                                                        (
                                                            event.target as HTMLInputElement
                                                        ).value = "";
                                                    }}
                                                    onChange={(event) => {
                                                        const target =
                                                            event.target as HTMLInputElement;
                                                        if (
                                                            target.files &&
                                                            target.files
                                                                .length > 0
                                                        ) {
                                                            handleSourceTypeChange(
                                                                {
                                                                    type: "media",
                                                                    src: URL.createObjectURL(
                                                                        target
                                                                            .files[0]
                                                                    ),
                                                                }
                                                            );
                                                        }
                                                    }}
                                                />
                                                {sourceType.type ===
                                                    "media" && (
                                                    <MdCheck
                                                        size={16}
                                                        className="ml-auto"
                                                    />
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
                                                <MdTvOff
                                                    size={16}
                                                    className="mr-2"
                                                />
                                                <span>Noise</span>
                                                {sourceType.type ===
                                                    "noise" && (
                                                    <MdCheck
                                                        size={16}
                                                        className="ml-auto"
                                                    />
                                                )}
                                            </div>
                                        </RadixMenu.Item>
                                    </>
                                )}
                                {currentMenu === "quality" && (
                                    <>
                                        {props.resolutionOptions.map(
                                            (resolution) => (
                                                <RadixMenu.Item
                                                    key={resolution}
                                                    onSelect={(event) => {
                                                        event.preventDefault();
                                                        let newResolutions = [
                                                            ...selectedResolutions,
                                                        ];
                                                        const index =
                                                            newResolutions.indexOf(
                                                                resolution
                                                            );
                                                        if (index !== -1) {
                                                            if (
                                                                newResolutions.length ===
                                                                1
                                                            ) {
                                                                return; // Don't allow unselecting all
                                                            }
                                                            newResolutions.splice(
                                                                index,
                                                                1
                                                            );
                                                        } else {
                                                            newResolutions.push(
                                                                resolution
                                                            );
                                                        }
                                                        newResolutions.sort();
                                                        setSelectedResolutions(
                                                            newResolutions
                                                        );
                                                        props.onQualityChange(
                                                            newResolutions.map(
                                                                (x) =>
                                                                    resolutionToSourceSetting(
                                                                        x
                                                                    )
                                                            )
                                                        );
                                                    }}
                                                    className="menu-item"
                                                >
                                                    <div className="w-full flex items-center ">
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
                                                </RadixMenu.Item>
                                            )
                                        )}
                                    </>
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
                                    props.videoRef["webkitExitFullscreen"]();
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
    );
};
