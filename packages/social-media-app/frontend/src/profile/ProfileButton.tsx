import { forwardRef, useEffect, useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Profile as ProfileData } from "@dao-xyz/social";
import { useProfiles } from "./useProfiles";
import { CanvasPreview } from "../canvas/Preview";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { useNavigate } from "react-router-dom";
import { getCanvasPath, MISSING_PROFILE } from "../routes";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { useIdentities } from "../identity/useIdentities";

// Extend the props type so any additional button props are allowed
export const ProfileButton = forwardRef<
    HTMLButtonElement,
    {
        publicKey: PublicSignKey;
        direction?: "row" | "col";
        setBgColor?: (color: string) => void;
        onClick?: () => void;
        size?: number;
    } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ size, publicKey, direction, setBgColor, onClick, ...rest }, ref) => {
    const { profiles } = useProfiles();
    const [profile, setProfile] = useState<ProfileData | undefined>();
    const { identities } = useIdentities();

    const navigate = useNavigate();
    useEffect(() => {
        if (profiles?.closed || !profiles) return;
        profiles.get(publicKey, identities).then((profile) => {
            setProfile(profile);
        });
    }, [
        !profiles || profiles?.closed ? undefined : profiles.address,
        publicKey.hashcode(),
    ]);

    const content = profile ? (
        <div
            className={`w-8 h-8 rounded-md overflow-hidden ${
                size != null ? `h-[${size}px] w-auto` : ""
            }`}
        >
            <CanvasWrapper canvas={profile.profile}>
                <CanvasPreview variant="tiny" />
            </CanvasWrapper>
        </div>
    ) : (
        <ProfilePhotoGenerated
            size={size ?? 32}
            publicKey={publicKey}
            onColorGenerated={setBgColor}
        />
    );

    const navigationHandler = () => {
        if (profile) {
            navigate(getCanvasPath(profile.profile), {});
        } else {
            navigate(MISSING_PROFILE);
        }
    };

    return (
        <button
            ref={ref}
            className="btn p-0 hover:filter hover:invert"
            onClick={onClick ? onClick : navigationHandler}
            {...rest} // Spread extra props so Radix's injected onClick, etc., get through
        >
            {content}
        </button>
    );
});
