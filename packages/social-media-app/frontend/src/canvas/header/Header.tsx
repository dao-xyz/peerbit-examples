import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";

export const Header = (props: {
    publicKey: PublicSignKey;
    direction?: "row" | "col";
}) => {
    const [bgColor, setBgColor] = useState("transparent");

    return (
        <div
            className={`flex items-center gap-4 ${
                props.direction === "col" ? "flex-col" : "flex-row"
            } 
      bg-[linear-gradient(333deg,rgba(255,255,255,0.6)_34%,var(--bgcolor)_79%)]
      dark:bg-[linear-gradient(333deg,rgba(31,41,55,0.6)_34%,var(--bgcolor)_79%)]`}
            style={
                {
                    "--bgcolor": bgColor
                        .replace("rgb", "rgba")
                        .replace(")", ",0.2)"),
                } as React.CSSProperties
            }
        >
            <ProfilePhotoGenerated
                size={32}
                publicKey={props.publicKey}
                onColorGenerated={(generatedColor) =>
                    setBgColor(generatedColor)
                }
            />
        </div>
    );
};
