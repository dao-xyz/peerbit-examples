import { useProgram } from "@peerbit/react";
import React, { useContext } from "react";
import { Profiles } from "@dao-xyz/social";

interface IProfilesContext {
    profiles?: Profiles;
}

export const ProfileContext = React.createContext<IProfilesContext>({} as any);
export const useProfiles = () => useContext(ProfileContext);
export const ProfileProvider = ({ children }: { children: JSX.Element }) => {
    const profiles = useProgram(new Profiles());
    console.log({ profiles });
    const memo = React.useMemo<IProfilesContext>(
        () => ({
            profiles: profiles.program,
        }),
        [profiles?.program]
    );

    return (
        <ProfileContext.Provider value={memo}>
            {children}
        </ProfileContext.Provider>
    );
};
