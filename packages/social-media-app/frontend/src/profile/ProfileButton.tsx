import { forwardRef, useEffect, useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Profile as ProfileData } from "@dao-xyz/social";
import { useProfiles } from "./useProfiles";
import { CanvasPreview } from "../canvas/Preview";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { useIdentities } from "../identity/useIdentities";

function pxToRem(px: number) {
    // Get computed base font size from root (html) element
    const baseFontSize = parseFloat(
        getComputedStyle(document.documentElement).fontSize
    );
    return `${px / baseFontSize}rem`;
}

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
    const { profiles, navigateTo } = useProfiles();
    const [profile, setProfile] = useState<ProfileData | undefined>();
    const { identities } = useIdentities();
    const sizeDefined = size ?? 32;
    const sizeInRem = pxToRem(sizeDefined);

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
            style={{ width: sizeInRem, height: sizeInRem }}
            className={`rounded-md overflow-hidden`}
        >
            <CanvasWrapper canvas={profile.profile}>
                <CanvasPreview onClick={onClick} variant="tiny" />
            </CanvasWrapper>
        </div>
    ) : (
        <ProfilePhotoGenerated
            size={sizeDefined}
            publicKey={publicKey}
            onColorGenerated={setBgColor}
        />
    );

    return (
        <button
            ref={ref}
            className="btn p-0 hover:filter hover:invert"
            onClick={onClick ? onClick : () => navigateTo(profile)}
            {...rest} // Spread extra props so Radix's injected onClick, etc., get through
        >
            {content}
        </button>
    );
});
