import { Grid, IconButton, Paper, TextField, Typography } from "@mui/material";
import {
    useEffect,
    useRef,
    useState,
    MutableRefObject,
    forwardRef,
} from "react";
import EditIcon from "@mui/icons-material/Edit";
import { useNames } from "./useNames";
import { Save } from "@mui/icons-material";

export const HEIGHT = "40px";
export const Header = forwardRef((props: any, ref) => {
    let [showInput, setShowInput] = useState(false);
    let inputRef = useRef<HTMLInputElement>();
    const { name, setName } = useNames();
    const [localName, setLocalName] = useState(name || "");

    useEffect(() => {
        if (name != null) {
            setLocalName(name);
        }
    }, [name]);
    useEffect(() => {
        if (!inputRef.current) {
            return;
        }

        let listener = (e) => {
            if (!inputRef.current) {
                return;
            }
            const rect = inputRef.current.getBoundingClientRect();
            if (
                rect.left < e.clientX &&
                e.clientX < rect.right &&
                rect.top < e.clientY &&
                e.clientY < rect.bottom
            ) {
                // inside
            } else {
                setShowInput(false);
            }
        };
        globalThis.addEventListener("click", listener);
        return () => globalThis.removeEventListener("click", listener);
    }, [inputRef.current]);

    const saveName = () => {
        setName(localName);
        setShowInput(false);
    };

    return (
        <Paper
            ref={ref as any}
            sx={{
                width: "100%",
                height: HEIGHT,
                display: "flex",
                alignItems: "center",
            }}
        >
            <Grid container item spacing={1}>
                <Grid item sx={{ ml: "auto" }}>
                    {!showInput && (
                        <Grid
                            spacing={1}
                            container
                            direction="row"
                            alignItems="center"
                            sx={{ cursor: "pointer" }}
                            onClick={() => {
                                setShowInput(true);
                            }}
                        >
                            <Grid item>
                                {name ? (
                                    <Typography>{name || ""}</Typography>
                                ) : (
                                    <Typography fontStyle="italic">
                                        Anonymous
                                    </Typography>
                                )}{" "}
                            </Grid>
                            <Grid item>
                                <IconButton
                                    size="small"
                                    sx={{ borderRadius: 0 }}
                                >
                                    <EditIcon />
                                </IconButton>{" "}
                            </Grid>
                        </Grid>
                    )}
                    {showInput && (
                        <Grid
                            container
                            direction="row"
                            alignItems="center"
                            spacing={1}
                        >
                            <Grid item>
                                <TextField
                                    ref={inputRef}
                                    onKeyDown={(e) =>
                                        e.key === "Enter" && saveName()
                                    }
                                    id="name-input"
                                    variant="standard"
                                    size="small"
                                    sx={{ ml: "auto" }}
                                    placeholder="Name"
                                    value={localName}
                                    InputProps={{
                                        disableUnderline: true,
                                    }}
                                    onChange={(e) => {
                                        setLocalName(e.target.value);
                                    }}
                                />
                            </Grid>
                            <Grid item>
                                <IconButton
                                    size="small"
                                    onClick={saveName}
                                    sx={{ borderRadius: 0 }}
                                >
                                    <Save />
                                </IconButton>{" "}
                            </Grid>
                        </Grid>
                    )}
                </Grid>
            </Grid>
        </Paper>
    );
});
