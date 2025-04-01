// ProfileProvider.tsx
import React, { useContext, useMemo, useRef } from "react";
import { useLocal, useProgram } from "@peerbit/react";
import { Profile, Profiles } from "@giga-app/interface";
import { useNavigate } from "react-router-dom";
import { getCanvasPath, MISSING_PROFILE } from "../routes";
import { PublicSignKey } from "@peerbit/crypto";

interface IProfilesContext {
    profiles?: Profiles;
    navigateTo: (profile: Profile | undefined) => void;
    getProfile: (publicKey: PublicSignKey, identities: any) => Promise<Profile>;
}

export const ProfileContext = React.createContext<IProfilesContext>({} as any);
export const useProfiles = () => useContext(ProfileContext);

export const ProfileProvider = ({ children }: { children: JSX.Element }) => {
    // Initialize the profiles program
    const profilesProgram = useProgram(new Profiles(), { existing: "reuse" });
    const navigate = useNavigate();
    // Create a cache to store fetched profiles (keyed by publicKey hash)
    const profileCache = useRef(new Map<string, Profile>());

    // Navigation handler (you can customize as needed)
    const navigationHandler = (profile: Profile) => {
        if (profile) {
            navigate(getCanvasPath(profile.profile), {});
        } else {
            navigate(MISSING_PROFILE);
        }
    };

    // getProfile first checks the cache; if not found, it fetches and caches it.
    const getProfile = async (
        publicKey: PublicSignKey,
        identities: any
    ): Promise<Profile> => {
        const key = publicKey.hashcode();
        if (profileCache.current.has(key)) {
            return profileCache.current.get(key)!;
        }
        if (!profilesProgram?.program) {
            throw new Error("Profiles program not available");
        }
        const profile = await profilesProgram.program.get(
            publicKey,
            identities
        );
        profileCache.current.set(key, profile);
        return profile;
    };

    // Memoize context values for better performance
    const memo = useMemo<IProfilesContext>(
        () => ({
            profiles: profilesProgram?.program,
            navigateTo: navigationHandler,
            getProfile,
        }),
        [profilesProgram, profilesProgram?.program?.closed, profilesProgram?.id]
    );

    return (
        <ProfileContext.Provider value={memo}>
            {children}
        </ProfileContext.Provider>
    );
};
