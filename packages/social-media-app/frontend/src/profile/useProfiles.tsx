// ProfileProvider.tsx
import React, { JSX, useContext, useMemo, useRef } from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas, Profile, ProfileIndexed, Profiles } from "@giga-app/interface";
import { WithIndexedContext } from "@peerbit/document";
import { useNavigate } from "react-router";
import { MISSING_PROFILE } from "../routes";
import { PublicSignKey, toBase64URL } from "@peerbit/crypto";

export type IndexedProfileRow = WithIndexedContext<Profile, ProfileIndexed>;

interface IProfilesContext {
    profiles: Profiles | undefined;
    create: (properties: { profile: Canvas }) => Promise<void>;
    navigateTo: (profile: IndexedProfileRow | undefined) => void;
    getProfile: (
        publicKey: PublicSignKey,
        identities: any
    ) => Promise<IndexedProfileRow>;
}

export const ProfileContext = React.createContext<IProfilesContext>({} as any);
export const useProfiles = () => useContext(ProfileContext);

export const ProfileProvider = ({ children }: { children: JSX.Element }) => {
    const { persisted } = usePeer();
    const navigate = useNavigate();

    // Open the registry
    const profilesProgram = useProgram(new Profiles(), {
        args: { replicate: !!persisted },
        existing: "reuse",
    });

    // Caches keyed by publicKey.hashcode()
    const profileCache = useRef(new Map<string, IndexedProfileRow>());
    const pendingRequests = useRef(
        new Map<string, Promise<IndexedProfileRow>>()
    );

    // Navigate to a profile's canvas id (from the indexed row)
    const navigateTo = (row: IndexedProfileRow | undefined) => {
        if (!row) {
            navigate(MISSING_PROFILE);
            return;
        }
        const idB64 = toBase64URL(row.__indexed.profile.id);
        navigate(`/c/${idB64}`);
    };

    // Fetch (with cache + de-dupe)
    const getProfile = async (
        publicKey: PublicSignKey,
        identities: any
    ): Promise<IndexedProfileRow> => {
        const key = publicKey.hashcode();

        // cache hit
        const hit = profileCache.current.get(key);
        if (hit) return hit;

        // in-flight
        const inflight = pendingRequests.current.get(key);
        if (inflight) return inflight;

        if (!profilesProgram?.program) {
            throw new Error("Profiles program not available");
        }

        const p = profilesProgram.program
            .get(publicKey, identities)
            .then((row) => {
                if (!row) {
                    return undefined;
                }
                profileCache.current.set(key, row);
                pendingRequests.current.delete(key);
                return row;
            })
            .catch((err) => {
                pendingRequests.current.delete(key);
                throw err;
            });

        pendingRequests.current.set(key, p);
        return p;
    };

    // Create or replace the current user's profile
    const create = async ({ profile }: { profile: Canvas }) => {
        if (!profilesProgram?.program) {
            throw new Error("Profiles program not available");
        }

        const key = profile.publicKey.hashcode();

        // Invalidate caches so next getProfile returns the newly indexed row
        profileCache.current.delete(key);
        pendingRequests.current.delete(key);

        await profilesProgram.program.create({
            publicKey: profile.publicKey,
            profile, // Canvas is fine; the program accepts Canvas | CanvasReference
        });
    };

    const memo = useMemo<IProfilesContext>(
        () => ({
            profiles: profilesProgram?.program,
            create,
            navigateTo,
            getProfile,
        }),
        [profilesProgram?.program]
    );

    return (
        <ProfileContext.Provider value={memo}>
            {children}
        </ProfileContext.Provider>
    );
};
