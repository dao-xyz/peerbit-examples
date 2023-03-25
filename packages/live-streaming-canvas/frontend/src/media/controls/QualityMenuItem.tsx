import {
    Divider,
    ListItemIcon,
    ListItemText,
    MenuItem,
    MenuList,
} from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import { Resolution } from "./settings";
import { Check } from "@mui/icons-material";
import { useEffect, useState } from "react";

export const QualityMenuItem = (props: {
    multiselect: boolean;
    selectedResolutions: Resolution[];
    resolutionOptions: Resolution[];
    onReturn: () => void;
    onChange: (resolution: Resolution[]) => void;
}) => {
    let [selectedResolutions, setSelectedResolutions] = useState<Resolution[]>(
        props.selectedResolutions
    );
    const handleResolutionChange = (resolution: Resolution) => {
        let newResolutions = [...selectedResolutions];
        const index = newResolutions.indexOf(resolution);
        if (index !== -1) {
            newResolutions.splice(index, 1);
        } else {
            if (props.multiselect) {
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
            props.onChange(newResolutions);
        }
    };

    return (
        <MenuList dense disablePadding>
            <MenuItem onClick={props.onReturn}>
                <ListItemIcon>
                    <ChevronLeftIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Quality</ListItemText>
            </MenuItem>
            <Divider />
            {props.resolutionOptions.map((resolution) => (
                <MenuItem
                    onClick={() => handleResolutionChange(resolution)}
                    key={resolution}
                    value={resolution}
                >
                    <ListItemText> {resolution}p</ListItemText>
                    {selectedResolutions.includes(resolution) && (
                        <Check fontSize="small" />
                    )}
                </MenuItem>
            ))}
        </MenuList>
    );
};
