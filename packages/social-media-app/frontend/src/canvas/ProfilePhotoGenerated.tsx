import { useEffect, useRef } from "react";
import { PublicSignKey } from "@peerbit/crypto";

interface ProfilePhotoGeneratedProps {
    publicKey: PublicSignKey;
    onColorGenerated?: (color: string) => void;
    size?: number;
}

export const ProfilePhotoGenerated = ({
    publicKey,
    onColorGenerated,
    size,
}: ProfilePhotoGeneratedProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sizeDefined = size || 64; // overall image size in pixels
    const cells = 5; // grid dimensions
    const cellSize = sizeDefined / cells;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Convert the public key (assumed to be a 32-byte Uint8Array) into a seed number.
        // Here, we simply sum the bytes for a very basic seed.
        const keyArray = new Uint8Array(publicKey.bytes);
        let seed = 0;
        keyArray.forEach((byte) => (seed += byte));

        // A simple linear congruential generator (LCG) as a pseudo-random number generator.
        function random() {
            // These constants are arbitrary; the goal is to have a reproducible sequence.
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        }

        // Pick a foreground color based on the PRNG.
        const r = Math.floor(random() * 256);
        const g = Math.floor(random() * 256);
        const b = Math.floor(random() * 256);
        const fgColor = `rgb(${r},${g},${b})`;

        if (onColorGenerated) {
            onColorGenerated(fgColor);
        }

        // Draw background (white)
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, sizeDefined, sizeDefined);

        // Set fill style to foreground color.
        ctx.fillStyle = fgColor;

        // Create a symmetric pattern.
        // We only fill in the left 3 columns and mirror them to the right.
        for (let x = 0; x < 3; x++) {
            for (let y = 0; y < cells; y++) {
                if (random() > 0.5) {
                    // Draw the square on the left.
                    ctx.fillRect(
                        x * cellSize,
                        y * cellSize,
                        cellSize,
                        cellSize
                    );
                    // Mirror it on the right.
                    ctx.fillRect(
                        (cells - 1 - x) * cellSize,
                        y * cellSize,
                        cellSize,
                        cellSize
                    );
                }
            }
        }
    }, [publicKey, cellSize, cells, size]);

    return <canvas ref={canvasRef} width={sizeDefined} height={sizeDefined} />;
};
