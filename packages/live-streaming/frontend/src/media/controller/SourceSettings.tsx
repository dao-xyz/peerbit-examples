import React, { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Dialog from "@mui/material/Dialog";
import RadioGroup from "@mui/material/RadioGroup";
import Radio from "@mui/material/Radio";
import FormControlLabel from "@mui/material/FormControlLabel";
import { StreamType } from "./settings";
import {
    FormControl,
    FormHelperText,
    Grid,
    IconButton,
    Input,
    InputAdornment,
    InputLabel,
    ListItemIcon,
    Menu,
    MenuItem,
    MenuList,
    OutlinedInput,
    Paper,
    Select,
    SelectChangeEvent,
    TextField,
    Typography,
} from "@mui/material";
import { inIframe } from "@dao-xyz/peerbit-react";
import VideoCameraFrontIcon from "@mui/icons-material/VideoCameraFront";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import PresentToAllIcon from "@mui/icons-material/PresentToAll";
import Settings from "@mui/icons-material/Settings";
import TvOffIcon from "@mui/icons-material/TvOff";
import ShareIcon from "@mui/icons-material/Share";
import Divider from "@mui/material/Divider";
import AppsIcon from "@mui/icons-material/Apps";
import { Check } from "@mui/icons-material";
import { Theme, useTheme } from "@mui/material/styles";
import { MediaStreamInfo, VideoInfo } from "../database";

export type Resolution = 360 | 480 | 720 | 1080;
export const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080];
export const resolutionToSourceSetting = (resolution: Resolution) => {
    if (resolution === 360) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 1e5,
                height: 360,
            },
        };
    }

    if (resolution === 480) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 2.5 * 1e5,
                height: 480,
            },
        };
    }

    if (resolution === 720) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 5 * 1e6,
                height: 720,
            },
        };
    }

    if (resolution === 1080) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 8e6,
                height: 1080,
            },
        };
    }

    throw new Error("Unsupported resolution: " + resolution);
};
/* 
function getMultiSelectStyles(key: string, keys: string[], theme: Theme) {
    return {
        fontWeight:
            keys.indexOf(key) === -1
                ? theme.typography.fontWeightRegular
                : theme.typography.fontWeightMedium,
    };
}
const ITEM_HEIGHT = 48;
const ITEM_PADDING_TOP = 8;

const MenuProps = {
    PaperProps: {
        style: {
            maxHeight: ITEM_HEIGHT * 4.5 + ITEM_PADDING_TOP,
            width: 250,
        },
    },
};

export const SourceSettingsDialog = (props: ConfirmationDialogRawProps) => {
    const { onClose,  open, ...other } = props;
    const [value, setValue] = React.useState<SourceSetting[]>([{ audio: { bitrate: 1e5 }, video: { bitrate: 1e7 } }]);
    const radioGroupRef = React.useRef<HTMLElement>(null);
    const theme = useTheme();
    const [selectedResolutions, setSelectedResolutions] = React.useState<Resolution[]>([]);


const handleEntering = () => {
    if (radioGroupRef.current != null) {
        radioGroupRef.current.focus();
    }
};

const handleCancel = () => {
    onClose();
};

const handleOk = () => {
    onClose(value);
};



const handleChange = (event: SelectChangeEvent<typeof RESOLUTIONS>) => {
    const {
        target: { value },
    } = event;
    const resolutions = typeof value === 'string' ? value.split(',') : value;
    setSelectedResolutions(
        // On autofill we get a stringified value.
        resolutions as Resolution[]
    );
    setValue((resolutions as Resolution[]).map(x => resolutionToSourceSetting(x)));
};

return (
    <Dialog
        sx={{ '& .MuiDialog-paper': { width: '80%', maxHeight: 435 } }}
        maxWidth="xs"
        TransitionProps={{ onEntering: handleEntering }}
        open={open}
        {...other}
    >
        <DialogTitle>Stream settings</DialogTitle>
        <DialogContent dividers>
            <Grid container direction="column">
                <Grid item>

                    <FormControl sx={{ m: 1, width: 300 }}>
                        <InputLabel id="demo-multiple-name-label">Resolution</InputLabel>
                        <Select
                            labelId="demo-multiple-name-label"
                            id="demo-multiple-name"
                            multiple
                            value={selectedResolutions}
                            onChange={handleChange}
                            input={<OutlinedInput label="Resolution" />}
                            MenuProps={MenuProps}
                        >
                            {RESOLUTIONS.map((resolution) => (
                                <MenuItem
                                    key={resolution}
                                    value={resolution}
                                    style={getMultiSelectStyles(resolution, selectedResolutions, theme)}
                                >
                                    {resolution}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>


                </Grid>
            </Grid>
        </DialogContent>
        <DialogActions>
            <Button autoFocus onClick={handleCancel}>
                Cancel
            </Button>
            <Button onClick={handleOk}>Ok</Button>
        </DialogActions>
    </Dialog>
);
}




const menuOptions = [
    'Screen',
    'Camera',
    'Media',
    'Noise'
];
export const SourceMenu = (props: { onStreamType: (settings: StreamType) => void }) => {
    const [sourceDialogOpen, setSourceDialogOpen] = useState<boolean>(false);
    const [openMenu, setOpenMenu] = useState(false)
    const [selectedMenuItem, setSelectedMenuItem] = useState(undefined);
    const [menuAnchorEl, setMenuAnchorEl] = React.useState<null | HTMLElement>(null);
    const [sourceType, setSourceType] = useState<'screen' | 'camera'>(undefined);

    return <Box>
        <SourceSettingsDialog open={sourceDialogOpen} onClose={(v) => {
            setSourceDialogOpen(false);
            return v?.length > 0 && props.onStreamType({ type: sourceType, settings: v })
        }}></SourceSettingsDialog>
        <Grid item container sx={{
            display: {
                xs: 'none',
                sm: 'block'
            }
        }}>
            <Grid
                item
                container
                spacing={1}
                justifyContent={!inIframe() ? "center" : "left"}
            >
                <Grid item>
                    <Button
                        size="small"
                        endIcon={<VideoCameraFrontIcon />}
                        onClick={() => {
                            setSourceType('camera')
                            setSourceDialogOpen(true)
                        }}
                    >
                        Camera
                    </Button>
                </Grid>
                <Grid item>
                    <Button
                        size="small"
                        endIcon={<PresentToAllIcon />}
                        onClick={() => {
                            setSourceType('screen')
                            setSourceDialogOpen(true)
                        }}
                    >
                        Screen
                    </Button>
                </Grid>
                <Grid item>
                    <Button
                        size="small"
                        component="label"
                        endIcon={
                            <OndemandVideoIcon />
                        } onClick={() => {
                            console.log('click!')
                            document.getElementById('media-file-select').click()
                        }}
                    >
                        Media
                        <input
                            id="media-file-select"
                            hidden
                            accept="video/*"
                            multiple
                            type="file"
                            onClick={(event) => { console.log('click'); (event.target["value"] = "") }}
                            onChange={(event) => {
                                if (event.target.files.length === 0) {
                                    return;
                                }
                                props.onStreamType({ type: "media", src: URL.createObjectURL(event.target.files[0]), settings: [new MediaStreamInfo({ video: new VideoInfo({ bitrate: 1e5 }) })] });
                            }}
                        />
                    </Button>
                </Grid>
                <Grid item>
                    <Button
                        size="small"
                        endIcon={<TvOffIcon />}
                        onClick={() => props.onStreamType({ type: 'noise' })}
                    >
                        Noise
                    </Button>
                </Grid>
            </Grid>

        </Grid>
        <Grid item container sx={{ display: { xs: 'block', sm: 'none' } }}>
            <IconButton onClick={(e) => { setMenuAnchorEl(e.currentTarget); setOpenMenu(!openMenu) }}><AppsIcon /></IconButton>
            <Menu
                id="source-menu"
                anchorEl={menuAnchorEl}
                open={openMenu}
                onClose={() => { }}
                MenuListProps={{
                    'aria-labelledby': 'source-button',
                    role: 'listbox',
                }}
            >
                {menuOptions.map((option, index) => (
                    <MenuItem
                        key={option}
                        selected={index === selectedMenuItem}
                        onClick={(event) => setSelectedMenuItem(index)}
                    >
                        {option}
                    </MenuItem>
                ))}
            </Menu>
        </Grid>
    </Box >
} 
*/
