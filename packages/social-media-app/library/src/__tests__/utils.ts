import { Canvas } from "../content";

/** Ensure a chain root → ...segments; returns the canvases in order. */
export async function ensurePath(
    root: Canvas,
    segments: string[]
): Promise<Canvas[]> {
    return root.createPath(segments);
}
