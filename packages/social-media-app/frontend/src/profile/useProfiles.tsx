// ProfileProvider.tsx
import React, { useContext, useMemo, useRef } from "react";
import { useLocal, useProgram } from "@peerbit/react";
import { Profile, Profiles } from "@giga-app/interface";
import { useNavigate } from "react-router";
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

    // Cache for fetched profiles keyed by publicKey hash
    const profileCache = useRef(new Map<string, Profile>());
    // Map to store ongoing fetch promises keyed by publicKey hash
    const pendingRequests = useRef(new Map<string, Promise<Profile>>());

    // Navigation handler (customize as needed)
    const navigationHandler = (profile: Profile) => {
        if (profile) {
            navigate(getCanvasPath(profile.profile), {});
        } else {
            navigate(MISSING_PROFILE);
        }
    };

    // getProfile checks both the cache and the pendingRequests map.
    // If the profile is not being fetched, it starts a new request.
    const getProfile = async (
        publicKey: PublicSignKey,
        identities: any
    ): Promise<Profile> => {
        const key = publicKey.hashcode();

        // Return from cache if available
        if (profileCache.current.has(key)) {
            return profileCache.current.get(key)!;
        }

        // If a fetch is already in progress, return the pending promise
        if (pendingRequests.current.has(key)) {
            return pendingRequests.current.get(key)!;
        }

        // Ensure the profiles program is available
        if (!profilesProgram?.program) {
            throw new Error("Profiles program not available");
        }

        // Create and store a fetch promise in the pendingRequests map
        const profilePromise = profilesProgram.program
            .get(publicKey, identities)
            .then((profile: Profile) => {
                // Cache the profile once the promise resolves
                profileCache.current.set(key, profile);
                // Clear the pending request since it's completed
                pendingRequests.current.delete(key);
                return profile;
            })
            .catch((error) => {
                // Remove the pending entry on error to allow for retries
                pendingRequests.current.delete(key);
                throw error;
            });

        pendingRequests.current.set(key, profilePromise);
        return profilePromise;
    };

    // Memoize context values for improved performance
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
