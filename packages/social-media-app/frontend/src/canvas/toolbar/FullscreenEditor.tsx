import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "../Canvas";
import { useToolbar } from "./ToolbarContext";

type FullscreenEditorProps = {
    children: React.ReactNode;
};

// Array of 30 casual, everyday titles.
const titles = [
    "What's on your mind?",
    "Share your moment",
    "Got something to share?",
    "Your update goes here",
    "Capture the moment",
    "What's happening?",
    "Share a photo, video, or game",
    "Tell us your story",
    "Your post, your way",
    "Make your mark",
    "Express yourself",
    "Share an idea",
    "Time to share",
    "Post something interesting",
    "Show your style",
    "Share your vibe",
    "Your idea, your post",
    "Let friends join in",
    "Create, share, connect",
    "Make a quick post",
    "Upload your favorite moments",
    "Post a quick update",
    "Have something to say?",
    "What's new today?",
    "Show off your creativity",
    "Share something fun",
    "Spin your story",
    "Share a game moment",
    "What do you want to share?",
    "Your canvas, your story",
    "Share a thought",
];

export const FullscreenEditor = ({ children }: FullscreenEditorProps) => {
    const { fullscreenEditorActive } = useToolbar();
    const startRef = useRef<HTMLHeadingElement>(null);
    // Pick a random title once when the component mounts.
    const randomTitle = useMemo(() => {
        return titles[Math.floor(Math.random() * titles.length)];
    }, []);

    useEffect(() => {
        if (fullscreenEditorActive && startRef.current) {
            startRef.current.scrollIntoView({
                // scroll to the top of the page
                behavior: "instant",
                block: "start",
                inline: "nearest",
            });
        }
    }, [fullscreenEditorActive]);
    if (fullscreenEditorActive) {
        return (
            <div className="overflow-auto  px-2 ">
                <span className="" ref={startRef}>
                    <h2>{randomTitle}</h2>
                </span>
                <Canvas fitWidth draft={true} inFullScreen />
            </div>
        );
    }
    return <>{children}</>;
};
