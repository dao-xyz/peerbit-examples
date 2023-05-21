import { useState, useEffect, useCallback } from "react";
import {
    Grid,
    IconButton,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    MenuList,
    Slider,
    Typography,
} from "@mui/material";
import Divider from "@mui/material/Divider";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import VideoSettingsIcon from "@mui/icons-material/VideoSettings";
import TuneIcon from "@mui/icons-material/Tune";
import StreamIcon from "@mui/icons-material/Stream";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
} from "../../controls/settings.js";
import VideoCameraFrontIcon from "@mui/icons-material/VideoCameraFront";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import PresentToAllIcon from "@mui/icons-material/PresentToAll";
import TvOffIcon from "@mui/icons-material/TvOff";
import { Check, Fullscreen } from "@mui/icons-material";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import "./../../controls/Controls.css";
import { QualityMenuItem } from "../../controls/QualityMenuItem.js";
import useVideoPlayer from "./useVideoPlayer.js";

export const Controls = (props: {
    resolutionOptions: Resolution[];
    selectedResolution?: Resolution[];
    onStreamTypeChange?: (settings: StreamType) => void;
    onQualityChange: (settings: SourceSetting[]) => void;
    videoRef: HTMLVideoElement;
    viewRef: HTMLCanvasElement | HTMLVideoElement;
}) => {
    const [showControls, setShowControls] = useState(false);

    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(
        /* !(props as { videoRef: HTMLVideoElement }).videoRef?.muted ?? */ false
    );
    const [prevMuteVolume, setPrevMuteVolume] = useState(
        /* (props as { videoRef: HTMLVideoElement }).videoRef?.volume ?? */ 1
    );
    const [volume, setVolume] = useState(
        /* (props as { videoRef: HTMLVideoElement }).videoRef?.volume ??  */ 1
    );

    const controlRef = useCallback((node) => {
        if (node) addShowControlsListener(node);
    }, []);

    /*  let controls = (props as { controls: ControlFunctions }).controls || ; */
    let controls = useVideoPlayer(props.videoRef);

    const togglePlay = () => {
        const isPlayingNow = !controls.isPlaying;
        isPlayingNow ? controls.play() : controls.pause();
        // setIsPlaying(isPlayingNow)
    };

    const addShowControlsListener = (ref: HTMLElement) => {
        ref.addEventListener("mouseover", () => {
            setShowControls(true);
        });
        ref.addEventListener("mouseleave", () => {
            setShowControls(false);
        });
    };
    useEffect(() => {
        console.log("view ref!", props.viewRef);
        if (!props.viewRef) {
            return;
        }

        addShowControlsListener(props.viewRef);
    }, [props.viewRef]);

    const [videoSettingsAnchor, setVideoSettingsAnchor] =
        useState<null | HTMLElement>(null);

    const [settingsOpen, setSettingsOpen] = useState<
        "main" | "resolution" | "source" | undefined
    >(undefined);
    let [selectedResolutions, setSelectedResolutions] = useState<Resolution[]>(
        props.selectedResolution
    );

    const [sourceType, setSourceType] = useState<StreamType>({ type: "noise" });
    const [prevSettings, setPrevSettings] = useState<StreamType>({
        type: "noise",
    });

    const handleVideoSettingsClose = () => {
        setSettingsOpen(undefined);

        /*   if (sourceType.type === "camera" || sourceType.type === "screen") {
              sourceType.settings = selectedResolutions.map((x) =>
                  resolutionToSourceSetting(x)
              );
          } else if (sourceType.type === "media") {
              sourceType.settings = [
                  {
                      audio: new AudioInfo({ bitrate: 1e5 }),
                      video: {
                          bitrate: resolutionToSourceSetting(720).video.bitrate,
                      },
                  },
              ];
          } */

        /*  const currentJSON = JSON.stringify(sourceType);
         console.log('CHANGE?', currentJSON, currentJSON !== JSON.stringify(prevSettings))
         if (currentJSON !== JSON.stringify(prevSettings)) {
             // TODO perf
             setPrevSettings(JSON.parse(currentJSON)); // clone so we don't modify it later
             props.onStreamTypeChange(sourceType);
         } */
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
        handleVideoSettingsClose();
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

    useEffect(() => {
        let compatibleResolutions = selectedResolutions.filter((x) =>
            props.resolutionOptions.includes(x)
        );
        if (compatibleResolutions.length === selectedResolutions.length) {
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

    useEffect(() => {
        setSelectedResolutions(props.selectedResolution);
    }, [props.selectedResolution]);

    return (
        <Grid
            container
            ref={controlRef}
            direction="column"
            className="controls"
            sx={{ opacity: showControls ? 1 : 0 }}
        >
            <Grid
                container
                item
                direction="row"
                justifyContent="center"
                alignItems="center"
            >
                <Grid item justifyContent="center">
                    <IconButton onClick={togglePlay} sx={{ borderRadius: 0 }}>
                        {!controls.isPlaying ? (
                            <PlayArrowIcon />
                        ) : (
                            <PauseIcon />
                        )}
                    </IconButton>
                </Grid>
                {controls.mute && (
                    <Grid id="volume-button" item justifyContent="center">
                        <IconButton
                            onClick={toggleMute}
                            sx={{ borderRadius: 0 }}
                        >
                            {muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
                        </IconButton>
                    </Grid>
                )}
                {controls.setVolume && (
                    <Grid
                        id="volume-slider"
                        item
                        justifyContent="center"
                        display="none"
                        sx={{ width: "75px", pl: 1 }}
                    >
                        <Slider
                            size="small"
                            aria-label="Volume"
                            value={volume || 1}
                            max={1}
                            step={0.005}
                            onChange={(e, v) => {
                                setNewVolume(v as number);
                            }}
                        />
                    </Grid>
                )}

                <Grid item sx={{ ml: "auto" }}>
                    <IconButton
                        sx={{ borderRadius: 0 }}
                        onClick={(e) => {
                            setVideoSettingsAnchor(e.currentTarget);
                            setSettingsOpen("main");
                        }}
                    >
                        <VideoSettingsIcon />
                    </IconButton>
                    <Menu
                        anchorEl={videoSettingsAnchor}
                        id="account-menu"
                        open={settingsOpen === "main"}
                        onClose={handleVideoSettingsClose}
                        PaperProps={{
                            elevation: 0,
                            sx: {
                                width: "250px",
                                maxWidth: "100%",
                                overflow: "visible",
                                filter: "drop-shadow(0px 2px 8px rgba(0,0,0,0.32))",
                                mb: 1.5,
                                "& .MuiAvatar-root": {
                                    width: 32,
                                    height: 32,
                                    ml: -0.5,
                                    mr: 1,
                                },
                                "&:before": {
                                    content: '""',
                                    display: "block",
                                    position: "absolute",
                                    bottom: -10,
                                    right: 14,
                                    width: 10,
                                    height: 10,
                                    bgcolor: "background.paper",
                                    transform: "translateY(-50%) rotate(45deg)",
                                    zIndex: 0,
                                },
                            },
                        }}
                        transformOrigin={{
                            horizontal: "right",
                            vertical: "bottom",
                        }}
                        anchorOrigin={{ horizontal: "right", vertical: "top" }}
                    >
                        <MenuList dense disablePadding>
                            <MenuItem onClick={() => setSettingsOpen("source")}>
                                <ListItemIcon>
                                    <StreamIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Source</ListItemText>
                            </MenuItem>
                            <Divider />
                            <MenuItem
                                onClick={() => setSettingsOpen("resolution")}
                                disabled={props.resolutionOptions.length === 0}
                            >
                                <ListItemIcon>
                                    <TuneIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Quality</ListItemText>
                                <Typography sx={{ ml: "auto" }} variant="body2">
                                    {selectedResolutions.length > 2
                                        ? `${selectedResolutions[0]}p, ${
                                              selectedResolutions[1]
                                          }p, (+${
                                              selectedResolutions.length - 2
                                          })`
                                        : selectedResolutions
                                              .map((x) => x + "p")
                                              .join(", ")}
                                </Typography>
                            </MenuItem>
                        </MenuList>
                    </Menu>

                    <Menu
                        anchorEl={videoSettingsAnchor}
                        id="resolutions-menu"
                        open={settingsOpen === "resolution"}
                        onClose={handleVideoSettingsClose}
                        PaperProps={{
                            elevation: 0,
                            sx: {
                                overflow: "visible",
                                filter: "drop-shadow(0px 2px 8px rgba(0,0,0,0.32))",
                                mb: 1.5,
                                "& .MuiAvatar-root": {
                                    width: 32,
                                    height: 32,
                                    ml: -0.5,
                                    mr: 1,
                                },
                            },
                        }}
                        transformOrigin={{
                            horizontal: "right",
                            vertical: "bottom",
                        }}
                        anchorOrigin={{ horizontal: "right", vertical: "top" }}
                    >
                        <QualityMenuItem
                            multiselect
                            onChange={(change) => {
                                setSelectedResolutions(change);
                                props.onQualityChange(
                                    change.map((x) =>
                                        resolutionToSourceSetting(x)
                                    )
                                );
                            }}
                            onReturn={() => {
                                handleVideoSettingsClose();
                                setSettingsOpen("main");
                            }}
                            selectedResolutions={selectedResolutions}
                            resolutionOptions={props.resolutionOptions}
                        />
                    </Menu>

                    <Menu
                        anchorEl={videoSettingsAnchor}
                        id="source-menu"
                        open={settingsOpen === "source"}
                        onClose={handleVideoSettingsClose}
                        PaperProps={{
                            elevation: 0,
                            sx: {
                                width: "175px",
                                overflow: "visible",
                                filter: "drop-shadow(0px 2px 8px rgba(0,0,0,0.32))",
                                mb: 1.5,
                                "& .MuiAvatar-root": {
                                    width: 32,
                                    height: 32,
                                    ml: -0.5,
                                    mr: 1,
                                },
                            },
                        }}
                        transformOrigin={{
                            horizontal: "right",
                            vertical: "bottom",
                        }}
                        anchorOrigin={{ horizontal: "right", vertical: "top" }}
                    >
                        <MenuList dense disablePadding>
                            <MenuItem
                                onClick={() => {
                                    handleVideoSettingsClose();
                                    setSettingsOpen("main");
                                }}
                            >
                                <ListItemIcon>
                                    <ChevronLeftIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Source</ListItemText>
                            </MenuItem>
                            <Divider />
                            <MenuItem
                                onClick={() =>
                                    handleSourceTypeChange({
                                        type: "camera",
                                    })
                                }
                            >
                                <ListItemIcon>
                                    <VideoCameraFrontIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Camera</ListItemText>
                                {sourceType.type === "camera" && (
                                    <Check
                                        sx={{ ml: "auto" }}
                                        fontSize="small"
                                    />
                                )}
                            </MenuItem>
                            <MenuItem
                                onClick={() =>
                                    handleSourceTypeChange({
                                        type: "screen",
                                    })
                                }
                            >
                                <ListItemIcon>
                                    <PresentToAllIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Screen</ListItemText>
                                {sourceType.type === "screen" && (
                                    <Check
                                        sx={{ ml: "auto" }}
                                        fontSize="small"
                                    />
                                )}
                            </MenuItem>
                            <MenuItem
                                onClick={() => {
                                    document
                                        .getElementById("media-file-select")
                                        .click();
                                }}
                            >
                                <ListItemIcon>
                                    <OndemandVideoIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Media</ListItemText>
                                <input
                                    id="media-file-select"
                                    hidden
                                    accept="video/*"
                                    multiple
                                    type="file"
                                    onClick={(event) =>
                                        (event.target["value"] = "")
                                    }
                                    onChange={(event) => {
                                        if (event.target.files.length === 0) {
                                            return;
                                        }
                                        handleSourceTypeChange({
                                            type: "media",
                                            src: URL.createObjectURL(
                                                event.target.files[0]
                                            ),
                                        });
                                    }}
                                />

                                {sourceType.type === "media" && (
                                    <Check
                                        sx={{ ml: "auto" }}
                                        fontSize="small"
                                    />
                                )}
                            </MenuItem>
                            <MenuItem
                                onClick={() =>
                                    handleSourceTypeChange({ type: "noise" })
                                }
                            >
                                <ListItemIcon>
                                    <TvOffIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Noise</ListItemText>
                                {sourceType.type === "noise" && (
                                    <Check
                                        sx={{ ml: "auto" }}
                                        fontSize="small"
                                    />
                                )}
                            </MenuItem>
                        </MenuList>
                    </Menu>

                    {/*  <Select
            size="small"
            className="velocity"
            value={playerState?.speed}
            onChange={(e) => handleVideoSpeed(e)}
        >
            <MenuItem value={0.5}>0.5x</MenuItem>
            <MenuItem value={1}>1x</MenuItem>
            <MenuItem value={1.25}>1.25x</MenuItem>
            <MenuItem value={2}>2x</MenuItem>
        </Select> */}
                </Grid>

                {/*  <Grid item justifyContent="center">
                    <IconButton onClick={() => { }} sx={{ borderRadius: 0 }}>
                        <FitScreen />
                    </IconButton>
                </Grid> */}
                <Grid item justifyContent="center">
                    <IconButton
                        onClick={() => {
                            props.viewRef?.requestFullscreen();
                        }}
                        sx={{ borderRadius: 0 }}
                    >
                        <Fullscreen />
                    </IconButton>
                </Grid>
            </Grid>
        </Grid>
    );
};
