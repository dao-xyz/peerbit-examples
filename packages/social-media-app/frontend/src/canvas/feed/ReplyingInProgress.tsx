import { ProfileButton } from "../../profile/ProfileButton";
import { Canvas } from "@giga-app/interface";
import { useReplyProgress } from "../main/useReplyProgress";
import { useEffect } from "react";

export const ReplyingInProgress = (properties: { canvas: Canvas }) => {
    const { canvas } = properties;
    const { getReplying, registerCanvas } = useReplyProgress();

    useEffect(() => {
        if (!canvas?.initialized) {
            return;
        }
        registerCanvas(canvas);
    }, [canvas?.idString, canvas?.initialized]);

    const replyingPeers =
        canvas?.initialized ? getReplying(canvas.idString) : [];

    // If no canvas or no replying peers, don't render anything.
    if (!canvas || replyingPeers.length === 0) return null;

    // Define the total number of icons to display
    const TOTAL_ICONS = 4;
    // The maximum number of profile photos to show is 3.
    const MAX_PROFILE_PHOTOS = 3;

    return (
        <div className="w-full h-0 mt-[-20px] flex items-center gap-2 justify-center">
            <div className="max-w-[876px] w-full flex items-center justify-end space-x-1">
                <div className="typing w-auto px-2 flex gap-1">
                    {replyingPeers.length <= MAX_PROFILE_PHOTOS ? (
                        <>
                            {/* Render profile photos */}
                            {replyingPeers.map((peerKey) => (
                                <ProfileButton
                                    key={peerKey.toString()}
                                    publicKey={peerKey}
                                    size={15}
                                    className="rounded-full overflow-hidden typing-circle scaling-demure"
                                />
                            ))}
                            {/* Render animated dots to fill up the remaining slots */}
                            {Array.from({
                                length: TOTAL_ICONS - replyingPeers.length - 1,
                            }).map((_, index) => (
                                <span
                                    key={`dot-${index}`}
                                    className="typing-circle scaling w-[10px] h-[10px]"
                                ></span>
                            ))}
                        </>
                    ) : (
                        <>
                            {/* If more than 3 peers replying, show 3 profile photos */}
                            {replyingPeers
                                .slice(0, MAX_PROFILE_PHOTOS)
                                .map((peerKey) => (
                                    <ProfileButton
                                        key={peerKey.toString()}
                                        publicKey={peerKey}
                                        size={15}
                                        rounded
                                        className="overflow-hidden typing-circle scaling-demure"
                                    />
                                ))}
                            {/* And show a plus indicator for the extra peers */}
                            <span className="text-xs">
                                +{replyingPeers.length - MAX_PROFILE_PHOTOS}
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
