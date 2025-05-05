// ProfileButton.tsx
import { forwardRef, useEffect, useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Profile as ProfileData } from "@giga-app/interface";
import { useProfiles } from "./useProfiles";
import { CanvasPreview } from "../canvas/Preview";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { useIdentities } from "../identity/useIdentities";
import { debounceLeadingTrailing, usePeer } from "@peerbit/react";

function pxToRem(px: number) {
    // Convert pixels to rem using the root font-size
    const baseFontSize = parseFloat(
        getComputedStyle(document.documentElement).fontSize
    );
    return `${px / baseFontSize}rem`;
}

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
    const { profiles, navigateTo, getProfile } = useProfiles();
    const [profile, setProfile] = useState<ProfileData | undefined>();
    const { identities } = useIdentities();
    const sizeDefined = size ?? 32;
    const sizeInRem = pxToRem(sizeDefined);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!profiles || profiles.closed || !identities || identities.closed)
            return;

        const listener = debounceLeadingTrailing(() => {
            setLoading(true);
            // Use the cached getProfile helper here
            getProfile(publicKey, identities)
                .then((profileData) => {
                    setProfile(profileData);
                })
                .finally(() => setLoading(false));
        }, 100);

        // Listen for changes in profiles (if the underlying data updates)
        profiles.profiles.events.addEventListener("change", listener);
        listener();
        return () => {
            profiles.profiles.events.removeEventListener("change", listener);
        };
    }, [
        profiles,
        identities,
        identities?.closed,
        profiles?.closed,
        publicKey.hashcode(),
    ]);

    const getContent = () => {
        if (!loading && profile) {
            return (
                <div
                    style={{ width: sizeInRem, height: sizeInRem }}
                    className="rounded-md overflow-hidden"
                >
                    <CanvasWrapper canvas={profile.profile}>
                        <CanvasPreview onClick={onClick} variant="tiny" />
                    </CanvasWrapper>
                </div>
            );
        }
        return (
            <>
                <ProfilePhotoGenerated
                    size={sizeDefined}
                    publicKey={publicKey}
                    onColorGenerated={setBgColor}
                />
            </>
        );
    };

    const content = getContent();
    return (
        <button
            ref={ref}
            className="btn p-0 hover:filter hover:invert"
            onClick={
                onClick
                    ? onClick
                    : (e) => {
                          e.stopPropagation();
                          navigateTo(profile);
                      }
            }
            {...rest}
        >
            {content}
        </button>
    );
});
