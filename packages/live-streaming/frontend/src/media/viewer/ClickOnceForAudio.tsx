import React, { useState, useEffect, useCallback } from "react";
import "./ClickOnceForAudio.css"; // Make sure this path is correct
import VolumeUpIcon from "@mui/icons-material/VolumeUp"; // Import the volume icon

const ClickOnceForAudio = ({ play, children }) => {
    const [hasClicked, setHasClicked] = useState(false);

    const handleGlobalClick = useCallback(() => {
        if (!hasClicked) {
            play();
            setHasClicked(true);
        }
    }, [hasClicked, play]);

    useEffect(() => {
        window.addEventListener("click", handleGlobalClick);

        return () => {
            window.removeEventListener("click", handleGlobalClick);
        };
    }, [handleGlobalClick]);

    return (
        <div className="video-container">
            {children}
            {!hasClicked && (
                <div
                    className="video-prompt"
                    style={{
                        animation: `shrinkToIcon 0.5s ease-in-out 3s forwards`,
                    }}
                >
                    <VolumeUpIcon
                        style={{
                            color: "white",
                            fontSize: "24px",
                            marginRight: "10px",
                        }}
                    />
                    <span className="click-text">Click to play audio</span>
                </div>
            )}
        </div>
    );
};

export default ClickOnceForAudio;
