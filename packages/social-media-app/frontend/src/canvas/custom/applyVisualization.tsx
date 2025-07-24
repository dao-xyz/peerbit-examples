// CustomizedBackground.tsx
import React, { useMemo } from "react";
import {
    BasicVisualization,
    ModedBackground,
    StyledBackground,
    CanvasBackground,
    BackGroundTypes,
} from "@giga-app/interface";
import { useVisualizationContext } from "./CustomizationProvider";
import { useThemeContext } from "../../theme/useTheme";
import { BodyStyler } from "./BodyStyler";

/* ───────── helper: css string → style object ───────── */
function parseStyle(css: string): React.CSSProperties {
    return css
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .reduce<React.CSSProperties>((acc, decl) => {
            const [prop, ...value] = decl.split(":");
            if (!prop || !value.length) return acc;
            const camel = prop
                .trim()
                .replace(/-([a-z])/g, (_, c) =>
                    c.toUpperCase()
                ) as keyof React.CSSProperties;
            acc[camel] = value.join(":").trim() as any;
            return acc;
        }, {});
}

/* ───────── helper: background object → style ───────── */
function styleFrom(bg?: BackGroundTypes): React.CSSProperties {
    if (!bg) return {};
    if (bg instanceof StyledBackground) return parseStyle(bg.css);
    if (bg instanceof CanvasBackground) {
        throw new Error("Unsupported");
    }
    return {}; // UploadedImageBackground handled by css var elsewhere
}

export const CustomizedBackground: React.FC<{
    className?: string;
    children?: React.ReactNode;
}> = ({ className = "", children }) => {
    const { visualization, draft } = useVisualizationContext();
    const { theme } = useThemeContext(); // 'light' | 'dark'
    const isDark = theme === "dark";

    /* build style when viz or theme changes */
    const style = useMemo(() => {
        let visualizationToUse = draft || visualization;
        if (!visualizationToUse) return
        const v = visualizationToUse as BasicVisualization;
        const bgWrap = v.background as ModedBackground;
        if (!bgWrap) return
        const chosen = isDark ? bgWrap.dark ?? bgWrap.light : bgWrap.light;
        return styleFrom(chosen);
    }, [
        draft,
        isDark,
        (visualization as BasicVisualization | undefined)?.background?.light,
        (visualization as BasicVisualization | undefined)?.background?.dark,
    ]);

    return (
        <div
            className={`min-h-screen h-full w-full ${className}`}
            style={style}
        >
            {!style && <BodyStyler />}
            {children}
        </div>
    );
};
