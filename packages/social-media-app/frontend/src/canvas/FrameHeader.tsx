import { Element } from "@dao-xyz/social";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { useState } from "react";

export const FrameHeader = (properties: { element: Element }) => {
    const [backgroundColor, setBackgroundColor] =
        useState<string>("transparent");

    // shpw profile image, name, and timestamp
    return (
        <div
            className="flex flex-row items-center gap-4"
            style={{
                backgroundColor,
            }}
        >
            <ProfilePhotoGenerated
                size={32}
                publicKey={properties.element.publicKey}
                onColorGenerated={(generatedColor) =>
                    setBackgroundColor(
                        generatedColor
                            .replace("rgb", "rgba")
                            .replace(")", ",0.2)")
                    )
                }
            />
        </div>
    );
};
