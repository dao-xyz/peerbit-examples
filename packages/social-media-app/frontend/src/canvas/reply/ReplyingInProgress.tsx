import { TbBubbleText } from "react-icons/tb";
import { ProfileButton } from "../../profile/ProfileButton";
import { Canvas } from "@giga-app/interface";
import { useReplyProgress } from "./useReplyProgress";
import { useEffect } from "react";

export const ReplyingInProgress = (properties: { canvas: Canvas }) => {
    const { canvas } = properties;
    const { getReplying, registerCanvas } = useReplyProgress();

    useEffect(() => {
        if (!canvas || canvas.closed) {
            return;
        }
        registerCanvas(canvas);
    }, [canvas?.idString, canvas?.closed]);

    const replyingPeers =
        canvas && canvas.closed === false ? getReplying(canvas.address) : [];

    return (
        canvas &&
        replyingPeers.length > 0 && (
            <div className="w-full h-0  mt-[-20px]  flex items-center gap-2 justify-center">
                <div className="max-w-[876px]  w-full flex items-center justify-end space-x-1">
                    {replyingPeers.slice(0, 3).map((peerKey) => (
                        <ProfileButton
                            key={peerKey.toString()}
                            publicKey={peerKey}
                            size={20}
                            className="rounded-full overflow-hidden"
                        />
                    ))}
                    {/* TODO show dots? {replyingPeers.length > 3 && <span className="text-xs text-gray-600">...</span>} */}
                    <TbBubbleText
                        className="bounce ml-[-10px] mt-[-30px]"
                        size={24}
                    />
                </div>
            </div>
        )
    );
};
