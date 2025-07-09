// CustomizationProvider.tsx
import React, {
    createContext,
    useMemo,
    useContext,
    useState,
    useEffect,
} from "react";
import {
    BasicVisualization,
    Visualization,
    Canvas,
    ModedBackground,
    StyledBackground,
    ModedThemePalette,
    SimpleThemePalette,
} from "@giga-app/interface";
import { equals } from "uint8arrays";
import { useView } from "../view/ViewContext";
import { useThemeContext } from "../../theme/useTheme";
import { useVisualization } from "./useVisualization";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";

/* ─── context type ───────────────────────────────────────────── */
interface VisualizationCtx {
    canvas?: Canvas;

    isLoading: boolean;
    /** last saved vis (DB) */
    visualization?: Visualization;
    /** working copy shown in UI */
    draft?: BasicVisualization;
    /** mutate draft in-place and re-apply css */
    updateDraft: (d: BasicVisualization) => void;
    /** commit draft → Peerbit */
    saveDraft: () => Promise<void>;
    /** revert draft → last saved */
    cancelDraft: () => void;
    /** create a new draft based on last saved or empty */
    createDraft: (replace?: boolean) => void;
}
const Ctx = createContext<VisualizationCtx>({} as any);
export const useVisualizationContext = () => useContext(Ctx);

/* ─── provider ───────────────────────────────────────────────── */
export const CustomizationProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const { viewRoot: canvas, canvases } = useView();
    const { theme } = useThemeContext(); // 'light' | 'dark'

    const { isLoading, visualization, setVisualization } = useVisualization({
        canvas,
    });

    const [draft, setDraft] = useState<BasicVisualization | undefined>();

    const resetThemeVars = () => {
        const root = document.documentElement;
        [
            "primary-50",
            "primary-100",
            "primary-200",
            "primary-300",
            "primary-400",
            "primary-500",
            "primary-600",
            "primary-700",
            "primary-800",
            "primary-900",
            "primary-950",
            "secondary-50",
            "secondary-100",
            "secondary-200",
            "secondary-300",
            "secondary-400",
            "secondary-500",
            "secondary-600",
            "secondary-700",
            "secondary-800",
            "secondary-900",
            "secondary-950",
            "neutral-50",
            "neutral-100",
            "neutral-200",
            "neutral-300",
            "neutral-400",
            "neutral-500",
            "neutral-600",
            "neutral-700",
            "neutral-800",
            "neutral-900",
            "neutral-950",
        ].forEach((token) => root.style.removeProperty(`--color-${token}`));
    };

    useEffect(() => {
        // apply theme styles
        const visualizationToUse = draft || visualization;
        if (visualizationToUse instanceof BasicVisualization) {
            // if we have a visualization, apply its styles
            const applyPalette = (palette: SimpleThemePalette) => {
                const primary = palette.primary;
                const secondary = palette.secondary;

                const p = palette.shades(primary);
                const s = palette.shades(secondary);
                const neutral = palette.shades(palette.neutral);

                let root = document.documentElement;

                for (const k of Object.keys(p)) {
                    root.style.setProperty(`--color-primary-${k}`, p[+k]);
                    root.style.setProperty(`--color-secondary-${k}`, s[+k]);
                    root.style.setProperty(`--color-neutral-${k}`, neutral[+k]);
                }
            };

            if (theme === "dark" && visualizationToUse.palette?.dark) {
                applyPalette(visualizationToUse.palette.dark);
            } else if (visualizationToUse.palette?.light) {
                applyPalette(visualizationToUse.palette.light);
            }
        } else {
            resetThemeVars();
        }
    }, [visualization, draft, theme]);

    const updateDraft = (d: BasicVisualization): void => {
        setDraft(
            new BasicVisualization({
                canvasId: d.canvasId,
                background: d.background,
                palette: d.palette,
                id: d.id,
                previewHeight: d.previewHeight,
                showAuthorInfo: d.showAuthorInfo,
            })
        );
    };

    const saveDraft = async () => {
        if (draft && canvas) {
            await canvas.setVisualization(draft);
            setVisualization(draft);

            setDraft(undefined); // reset draft after saving
        }
    };

    const cancelDraft = () => {
        if (visualization) {
            setDraft(undefined);
        }
    };

    const createDraft = (replace?: boolean) => {
        if (draft && !replace) {
            // if we already have a draft, do not create a new one
            return;
        }
        if (visualization) {
            // create a new draft based on the last saved visualization
            setDraft(new BasicVisualization({ ...visualization }));
        } else {
            if (!canvas) {
                throw new Error("No canvas available to create a draft.");
            }
            // create a new empty draft
            setDraft(
                new BasicVisualization({
                    canvasId: canvas.id,
                    background: new ModedBackground({
                        light: new StyledBackground({
                            css: "background-color:#ffffff",
                        }),
                    }),
                    palette: new ModedThemePalette({
                        light: new SimpleThemePalette({}),
                    }),
                })
            );
        }
    };
    const navigate = useNavigate();

    const navigateToNarrative = async () => {
        // navigate to the first leaf that is of narrative type
        let root = canvases[canvases.length - 1];
        let feedContext = await root.getFeedContext();
        if (feedContext !== root) {
            navigate(getCanvasPath(feedContext));
        }
    };

    /* 4. context value ------------------------------------------- */
    const value = useMemo<VisualizationCtx>(
        () => ({
            canvas,
            isLoading,
            visualization,
            draft,
            createDraft,
            updateDraft,
            saveDraft,
            cancelDraft,
            navigateToNarrative,
        }),
        [canvas, isLoading, visualization, draft]
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
