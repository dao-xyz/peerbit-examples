import { forwardRef, useEffect, useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Canvas, IndexableCanvas, LOWEST_QUALITY, Profile as ProfileData } from "@giga-app/interface";
import { IndexedProfileRow, useProfiles } from "./useProfiles";
import { CanvasPreview } from "../canvas/render/preview/Preview";
import { ProfilePhotoGenerated } from "./ProfilePhotoGenerated";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { useIdentities } from "../identity/useIdentities";
import { debounceLeadingTrailing } from "@peerbit/react";
import { WithIndexedContext } from "@peerbit/document";
import { useInitializeCanvas } from "../canvas/useInitializedCanvas";

function pxToRem(px: number) {
    // Convert pixels to rem using the root font-size
    const baseFontSize = parseFloat(
        getComputedStyle(document.documentElement).fontSize
    );
    return `${px / baseFontSize}rem`;
}

type ProfileButtonInput = {
    className?: string;
    publicKey: PublicSignKey;
    direction?: "row" | "col";
    onClick?: () => void;
    size?: number;
    rounded?: boolean; // If true, apply rounded corners to the profile photo
    key?: string; // Optional key for React list rendering
};

export const ProfileButton = forwardRef<HTMLButtonElement, ProfileButtonInput>(
    function ProfileButton(
        { className = "", publicKey, onClick, size, rounded = false, key },
        ref
    ) {
        const { profiles, navigateTo, getProfile } = useProfiles();
        const [profile, setProfile] = useState<IndexedProfileRow | undefined>();
        const { identities } = useIdentities();
        const sizeDefined = size ?? 32;
        const sizeInRem = pxToRem(sizeDefined);
        const [loading, setLoading] = useState(true);

        const canvas = useInitializeCanvas(profile?.profile);

        useEffect(() => {
            if (
                !profiles ||
                profiles.closed ||
                !identities ||
                identities.closed
            )
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
                profiles.profiles.events.removeEventListener(
                    "change",
                    listener
                );
            };
        }, [
            profiles,
            identities,
            identities?.closed,
            profiles?.closed,
            publicKey.hashcode(),
        ]);

        const getContent = () => {
            if (loading) {
                return <div className={`${sizeInRem} ${sizeInRem}`} />;
            }

            if (profile) {
                return (
                    <div
                        style={{ width: sizeInRem, height: sizeInRem }}
                        className={
                            "overflow-hidden " + (rounded ? "rounded-md" : "")
                        }
                    >
                        <CanvasWrapper
                            quality={LOWEST_QUALITY}
                            canvas={canvas}
                        >
                            <CanvasPreview onClick={onClick} variant="tiny" />
                        </CanvasWrapper>
                    </div>
                );
            }
            return (
                <ProfilePhotoGenerated
                    size={sizeDefined}
                    className={rounded ? "rounded-md " : ""}
                    publicKey={publicKey}
                />
            );
        };

        const content = getContent();
        return (
            <button
                ref={ref}
                key={key}
                className={"btn p-0 hover:filter hover:invert " + className}
                onClick={
                    onClick
                        ? onClick
                        : (e) => {
                            e.stopPropagation();
                            navigateTo(profile);
                        }
                }
            >
                {content}
            </button>
        );
    }
);
