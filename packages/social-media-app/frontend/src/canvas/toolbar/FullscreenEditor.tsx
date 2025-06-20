import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "../Canvas";

type InlineEditorProps = {
    generateTitle?: boolean; // Optional prop to control title generation
    className?: string; // Optional class name for the container
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

export const InlineEditor = ({
    generateTitle,
    className,
}: InlineEditorProps) => {
    // Pick a random title once when the component mounts.
    const randomTitle = useMemo(() => {
        return titles[Math.floor(Math.random() * titles.length)];
    }, []);

    const ref = useRef<HTMLSpanElement>(null);
    // Use the ref to focus the title input if needed
    useEffect(() => {
        ref.current?.scrollIntoView({
            // scroll to the top of the page
            behavior: "instant",
            block: "start",
            inline: "nearest",
        });
    }, [ref]);

    return (
        <div className={` flex flex-col pb-12 h-full ${className}`}>
            {" "}
            {/* mb-12 does not work here */}
            {generateTitle && (
                <span className="px-2" ref={ref}>
                    <h2>{randomTitle}</h2>
                </span>
            )}
            <Canvas fitWidth draft={true} inFullScreen />
        </div>
    );
};
