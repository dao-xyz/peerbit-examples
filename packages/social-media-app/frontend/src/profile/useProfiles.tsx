import { useProgram } from "@peerbit/react";
import React, { useContext } from "react";
import { Profile, Profiles } from "@dao-xyz/social";
import { useNavigate } from "react-router-dom";
import { getCanvasPath, MISSING_PROFILE } from "../routes";

interface IProfilesContext {
    profiles?: Profiles;
    navigateTo: (profile: Profile | undefined) => void;
}

export const ProfileContext = React.createContext<IProfilesContext>({} as any);
export const useProfiles = () => useContext(ProfileContext);
export const ProfileProvider = ({ children }: { children: JSX.Element }) => {
    const profiles = useProgram(new Profiles());
    const navigate = useNavigate();

    const navigationHandler = (profile: Profile) => {
        if (profile) {
            navigate(getCanvasPath(profile.profile), {});
        } else {
            navigate(MISSING_PROFILE);
        }
    };

    const memo = React.useMemo<IProfilesContext>(
        () => ({
            profiles: profiles.program,
            navigateTo: navigationHandler,
        }),
        [profiles?.program]
    );

    return (
        <ProfileContext.Provider value={memo}>
            {children}
        </ProfileContext.Provider>
    );
};
