import { inIframe, usePeer } from "@dao-xyz/peerbit-react";
import {
    useRef,
    useState,
    useEffect,
    useCallback,
    MutableRefObject,
} from "react";
import { AudioInfo } from "../database";
import {
    Box,
    Button,
    Grid,
    IconButton,
    InputLabel,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    MenuList,
    OutlinedInput,
    Select,
    SelectChangeEvent,
    Slider,
    Theme,
    Typography,
    useTheme,
} from "@mui/material";
import { videoNoAudioMimeType, videoAudioMimeType } from "../format";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";

import Divider from "@mui/material/Divider";
import AppsIcon from "@mui/icons-material/Apps";
import useVideoPlayer from "../useVideoPlayer";
import "./Controls.css";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import VideoSettingsIcon from "@mui/icons-material/VideoSettings";
import TuneIcon from "@mui/icons-material/Tune";
import SlowMotionVideoIcon from "@mui/icons-material/SlowMotionVideo";
import StreamIcon from "@mui/icons-material/Stream";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
} from "./settings.js";
import VideoCameraFrontIcon from "@mui/icons-material/VideoCameraFront";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import PresentToAllIcon from "@mui/icons-material/PresentToAll";
import TvOffIcon from "@mui/icons-material/TvOff";
import { Check, Fullscreen } from "@mui/icons-material";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";

import Replay10Icon from "@mui/icons-material/Replay10";
import "./Controls.css";

export const Controls = (props: {
    isStreamer: boolean;
    resolutionOptions: Resolution[];
    selectedResolution?: Resolution[];
    videoRef?: HTMLVideoElement;
    onStreamTypeChange?: (settings: StreamType) => void;
    onQualityChange: (settings: SourceSetting[]) => void;
}) => {
    const theme = useTheme();
    const [showControls, setShowControls] = useState(false);
    const {
        isPlaying,
        progress,
        speed,
        setVolume,
        togglePlay,
        handleOnTimeUpdate,
        handleVideoProgress,
        handleVideoSpeed,
        toggleMute,
    } = useVideoPlayer(props.videoRef);

    const addShowControlsListener = (ref: HTMLElement) => {
        ref.addEventListener("mouseenter", () => {
            setShowControls(true);
        });
        ref.addEventListener("mouseleave", () => {
            setShowControls(false);
        });
    };
    const controlRef = useCallback((node) => {
        if (node) addShowControlsListener(node);
    }, []);

    useEffect(() => {
        if (!props.videoRef) {
            return;
        }

        props.videoRef.ontimeupdate = (ev) => {
            return handleOnTimeUpdate();
        };

        addShowControlsListener(props.videoRef);
    }, [props.videoRef]);

    const [videoSettingsAnchor, setVideoSettingsAnchor] =
        useState<null | HTMLElement>(null);
    const [settingsOpen, setSettingsOpen] = useState<
        "main" | "resolution" | "source" | undefined
    >(undefined);

    let [selectedResolutions, setSelectedResolutions] = useState<Resolution[]>(
        []
    );
    const [sourceType, setSourceType] = useState<StreamType>({ type: "noise" });
    const [prevSettings, setPrevSettings] = useState<StreamType>({
        type: "noise",
    });

    useEffect(() => {
        if (props.selectedResolution) {
            setSelectedResolutions(props.selectedResolution);
        }
    }, [props.selectedResolution]);
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

    const handleResolutionChange = (resolution: Resolution) => {
        let newResolutions = [...selectedResolutions];
        const index = newResolutions.indexOf(resolution);
        if (index !== -1) {
            newResolutions.splice(index, 1);
        } else {
            if (props.isStreamer) {
                newResolutions.push(resolution);
            } else {
                newResolutions = [resolution];
            }
        }
        newResolutions.sort();

        let change =
            JSON.stringify(newResolutions) !=
            JSON.stringify(selectedResolutions);

        setSelectedResolutions(
            // On autofill we get a stringified value.
            newResolutions
        );

        if (change) {
            props.onQualityChange(
                newResolutions.map((x) => resolutionToSourceSetting(x))
            );
        }
    };

    return (
        <Grid
            container
            ref={controlRef}
            direction="column"
            className="controls"
            sx={{ opacity: showControls ? 1 : 0 }}
        >
            <Grid
                item
                display="flex"
                justifyContent="center"
                sx={{ width: "100%", height: "15px", marginTop: "-14px" }}
            >
                <Slider
                    sx={{ borderRadius: "0px" }}
                    size="small"
                    min={0}
                    max={100}
                    value={progress || 0}
                    onChange={(e) => handleVideoProgress(e)}
                />
            </Grid>
            <Grid
                container
                item
                direction="row"
                justifyContent="center"
                alignItems="center"
            >
                <Grid item justifyContent="center">
                    <IconButton onClick={togglePlay} sx={{ borderRadius: 0 }}>
                        {!isPlaying ? <PlayArrowIcon /> : <PauseIcon />}
                    </IconButton>
                </Grid>
                {!props.isStreamer && (
                    <>
                        <Grid item>
                            <Button
                                color="inherit"
                                onClick={() =>
                                    (props.videoRef.currentTime =
                                        props.videoRef.buffered.length > 0
                                            ? props.videoRef.buffered.end(
                                                  props.videoRef.buffered
                                                      .length - 1
                                              )
                                            : 0)
                                }
                            >
                                Live
                            </Button>
                        </Grid>
                        <Grid item justifyContent="center">
                            <IconButton
                                onClick={() => {}}
                                sx={{ borderRadius: 0 }}
                            >
                                <Replay10Icon />
                            </IconButton>
                        </Grid>
                        <Grid id="volume-button" item justifyContent="center">
                            <IconButton
                                onClick={toggleMute}
                                sx={{ borderRadius: 0 }}
                            >
                                {props.videoRef?.muted ? (
                                    <VolumeOffIcon />
                                ) : (
                                    <VolumeUpIcon />
                                )}
                            </IconButton>
                        </Grid>
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
                                value={props.videoRef?.volume || 1}
                                max={1}
                                step={0.005}
                                onChange={(e, v) => {
                                    setVolume(v as number);
                                }}
                            />
                        </Grid>
                    </>
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
                            {props.isStreamer && (
                                <MenuItem
                                    onClick={() => setSettingsOpen("source")}
                                >
                                    <ListItemIcon>
                                        <StreamIcon fontSize="small" />
                                    </ListItemIcon>
                                    <ListItemText>Source</ListItemText>
                                </MenuItem>
                            )}
                            {props.isStreamer && <Divider />}
                            <MenuItem>
                                <ListItemIcon>
                                    <SlowMotionVideoIcon fontSize="small" />
                                </ListItemIcon>
                                <ListItemText>Playbackrate</ListItemText>
                                <Select
                                    sx={{
                                        ml: "auto",
                                        minHeight: 0,
                                        display: "flex",
                                        alignItems: "center",
                                        boxShadow: "none",
                                        ".MuiOutlinedInput-notchedOutline": {
                                            border: 0,
                                        },
                                    }}
                                    size="small"
                                    className="velocity"
                                    /* renderValue={(v) => <Typography variant="body2" sx={{}}>Speed {v}x</Typography>} */
                                    value={speed}
                                    onChange={(e) => handleVideoSpeed(e)}
                                >
                                    <MenuItem value={0.5}>0.5x</MenuItem>
                                    <MenuItem value={1}>1x</MenuItem>
                                    <MenuItem value={1.25}>1.25x</MenuItem>
                                    <MenuItem value={2}>2x</MenuItem>
                                </Select>
                            </MenuItem>
                            <MenuItem
                                onClick={() => setSettingsOpen("resolution")}
                                disabled={
                                    (props.isStreamer &&
                                        (sourceType.type === "noise" ||
                                            sourceType.type === "media")) ||
                                    props.resolutionOptions.length === 0
                                }
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
                                <ListItemText>Quality</ListItemText>
                            </MenuItem>
                            <Divider />
                            {props.resolutionOptions.map((resolution) => (
                                <MenuItem
                                    /*   labelId="demo-multiple-name-label"
                                  id="demo-multiple-name"
                                  multiple
                                  value={selectedResolutions} */
                                    /*                             onChange={handleResolutionChange} */
                                    /*  input={<OutlinedInput label="Resolution" /> */
                                    /*  MenuProps={MenuProps} */

                                    onClick={() =>
                                        handleResolutionChange(resolution)
                                    }
                                    key={resolution}
                                    value={resolution}
                                >
                                    <ListItemText> {resolution}p</ListItemText>
                                    {selectedResolutions.includes(
                                        resolution
                                    ) && <Check fontSize="small" />}
                                </MenuItem>
                            ))}
                        </MenuList>
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
                            props.videoRef?.requestFullscreen();
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