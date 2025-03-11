import { useProgram } from "@peerbit/react";
import React, { useContext } from "react";
import { Profiles } from "@dao-xyz/social";

interface IProfileContext extends Profiles {}

export const ProfileContext = React.createContext<IProfileContext>({} as any);
export const useProfiles = () => useContext(ProfileContext);
export const ProfileProvider = ({ children }: { children: JSX.Element }) => {
    const profiles = useProgram(new Profiles());
    return (
        <ProfileContext.Provider value={profiles.program}>
            {children}
        </ProfileContext.Provider>
    );
};
