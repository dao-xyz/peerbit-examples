import { useMemo, useRef } from "react";

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

export const CreatePostTitle = (properties?: { className?: string }) => {
    // Pick a random title once when the component mounts.
    const randomTitle = useMemo(() => {
        return titles[Math.floor(Math.random() * titles.length)];
    }, []);

    return (
        <h2
            className={"py-0 my-4 font-ganja " + properties?.className}
            style={{ fontWeight: 100 }}
        >
            {randomTitle}
        </h2>
    );
};
