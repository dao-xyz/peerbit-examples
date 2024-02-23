import { useEffect, useState } from "react";

export const getKeepAspectRatioBoundedSize = ({
    width,
    height,
}: {
    width: number;
    height: number;
}) => {
    const [styleHeight, setStyleHeight] = useState<"100dvh" | "fit-content">(
        "fit-content"
    );
    const [styleWidth, setStyleWidth] = useState<"100dvw" | "fit-content">(
        "100dvw"
    );

    useEffect(() => {
        const listener = () => {
            const containerSize: { width: number; height: number } = {
                width: window.innerWidth,
                height: window.innerHeight,
            };
            //   console.log(width / containerSize.width, height / containerSize.height)
            const isLimitedByHeight =
                width / containerSize.width < height / containerSize.height;

            if (isLimitedByHeight) {
                setStyleHeight("100dvh");
                setStyleWidth("fit-content");
            } else {
                setStyleHeight("fit-content");
                setStyleWidth("100dvw");
            }
        };
        listener();
        window.addEventListener("resize", listener);
        return () => window.removeEventListener("resize", listener);
    });
    return { width: styleWidth, height: styleHeight };
};
