import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import {
    Resolution,
    resolutionToSourceSetting,
    SourceSetting,
} from "../../controls/settings.js";
import { MdCheck } from "react-icons/md";

export const ResolutionSelect = (props: {
    resolutionOptions: Resolution[];
    selectedResolutions?: Resolution[];
    setSelectedResolutions: (resolution: Resolution[]) => void;
    onQualityChange: (settings: SourceSetting[]) => void;
}) => {
    return (
        <>
            {props.resolutionOptions.map((resolution) => (
                <RadixMenu.Item
                    key={resolution}
                    onSelect={(event) => {
                        event.preventDefault();
                        let newResolutions = [...props.selectedResolutions];
                        const index = newResolutions.indexOf(resolution);
                        if (index !== -1) {
                            if (newResolutions.length === 1) {
                                return; // Don't allow unselecting all
                            }
                            newResolutions.splice(index, 1);
                        } else {
                            newResolutions.push(resolution);
                        }
                        newResolutions.sort();
                        props.setSelectedResolutions(newResolutions);
                        props.onQualityChange(
                            newResolutions.map((x) =>
                                resolutionToSourceSetting(x)
                            )
                        );
                    }}
                    className="menu-item"
                >
                    <div className="w-full flex items-center ">
                        <span>{resolution}p</span>
                        {props.selectedResolutions?.includes(resolution) && (
                            <MdCheck size={16} className="ml-auto" />
                        )}
                    </div>
                </RadixMenu.Item>
            ))}
        </>
    );
};
