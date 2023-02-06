import React, { useState, useEffect } from "react";

export const WindowContext = React.createContext<{ windowIsActive: boolean }>(
    null
);

export const WindowContextProvider = (props) => {
    const [windowIsActive, setWindowIsActive] = useState(true);

    function handleActivity(forcedFlag) {
        if (typeof forcedFlag === "boolean") {
            return forcedFlag
                ? setWindowIsActive(true)
                : setWindowIsActive(false);
        }

        return document.hidden
            ? setWindowIsActive(false)
            : setWindowIsActive(true);
    }

    useEffect(() => {
        const handleActivityFalse = () => handleActivity(false);
        const handleActivityTrue = () => handleActivity(true);

        document.addEventListener("visibilitychange", handleActivity);
        document.addEventListener("blur", handleActivityFalse);
        window.addEventListener("blur", handleActivityFalse);
        window.addEventListener("focus", handleActivityTrue);
        document.addEventListener("focus", handleActivityTrue);

        return () => {
            window.removeEventListener("blur", handleActivity);
            document.removeEventListener("blur", handleActivityFalse);
            window.removeEventListener("focus", handleActivityFalse);
            document.removeEventListener("focus", handleActivityTrue);
            document.removeEventListener(
                "visibilitychange",
                handleActivityTrue
            );
        };
    }, []);

    return (
        <WindowContext.Provider value={{ windowIsActive }}>
            {props.children}
        </WindowContext.Provider>
    );
};
