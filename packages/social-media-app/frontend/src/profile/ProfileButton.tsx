import { forwardRef, useEffect, useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Profile as ProfileData } from "@dao-xyz/social";
import { useProfiles } from "./useProfiles";
import { CanvasPreview } from "../canvas/Preview";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { useNavigate } from "react-router-dom";
import { getCanvasPath, MISSING_PROFILE } from "../routes";

// Extend the props type so any additional button props are allowed
export const ProfileButton = forwardRef<
    HTMLButtonElement,
    {
        publicKey: PublicSignKey;
        direction?: "row" | "col";
        setBgColor: (color: string) => void;
        onClick?: () => void;
    } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ publicKey, direction, setBgColor, onClick, ...rest }, ref) => {
    const { profiles } = useProfiles();
    const [profile, setProfile] = useState<ProfileData | undefined>();
    const navigate = useNavigate();
    useEffect(() => {
        if (profiles?.closed || !profiles) return;
        profiles.get(publicKey).then((profile) => {
            setProfile(profile);
        });
    }, [
        !profiles || profiles?.closed ? undefined : profiles.address,
        publicKey.hashcode(),
    ]);

    const content = profile ? (
        <div className="w-[40px] h-[40px]">
            <CanvasPreview canvas={profile.profile} />
        </div>
    ) : (
        <ProfilePhotoGenerated
            size={32}
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
