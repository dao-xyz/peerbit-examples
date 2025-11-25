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
    SimpleThemePalette,
    ChildVisualization,
} from "@giga-app/interface";
import { useThemeContext } from "../../theme/useTheme";
import { useSearchParams } from "react-router";
import { useQuery } from "@peerbit/document-react";
import {
    IndexedVisualization,
    getOwnedByCanvasQuery,
} from "@giga-app/interface";
import { equals } from "uint8arrays";
import { STREAM_QUERY_PARAMS } from "../feed/StreamContext";
import { useCanvases } from "../useCanvas";

const useVisualization = (properies: { canvas: Canvas }) => {
    const { canvas } = properies;
    const [visualization, setVisualization] = useState<
        Visualization | undefined
    >();

    const query = useMemo(() => {
        return !canvas
            ? null
            : {
                  query: getOwnedByCanvasQuery(canvas),
              };
    }, [canvas?.idString]);

    /* 1. fetch the current saved visualization ------------------- */
    const { items, isLoading } = useQuery(canvas?.nearestScope.visualizations, {
        query,
        updates: {
            merge: true,
        },
        resolve: true,
        local: true,
        remote: {
            reach: { eager: true },
            wait: { timeout: 5000 },
        },
        prefetch: true,
    });

    useEffect(() => {
        if (items && items.length > 0) {
            // we have a visualization, set it
            const v = items[0] as IndexedVisualization;
            if (canvas && equals(v.canvasId, canvas.id)) {
                setVisualization(v);
            } else {
                setVisualization(undefined);
            }
        } else {
            // no visualization found
            setVisualization(undefined);
        }
    }, [items, canvas?.id]);

    return {
        visualization,
        setVisualization,
        isLoading,
    };
};

/* ─── context type ───────────────────────────────────────────── */
interface VisualizationCtx {
    canvas?: Canvas;

    isLoading: boolean;
    /** last saved vis (DB) */
    visualization?: BasicVisualization;
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

const CHILDREN_VISUALIZATION_PARAM_MAP = {
    feed: ChildVisualization.FEED,
    tree: ChildVisualization.OUTLINE,
    explore: ChildVisualization.EXPLORE,
    chat: ChildVisualization.CHAT,
};

const CHILDREN_VISUALIZATION_PARAM_MAP_REVERSE = Object.fromEntries(
    Object.entries(CHILDREN_VISUALIZATION_PARAM_MAP).map(([key, value]) => [
        value,
        key,
    ])
);

export const VIEW_PARAM_QUERY_KEY = "v";

/* ─── provider ───────────────────────────────────────────────── */
export const CustomizationProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const { viewRoot: canvas } = useCanvases();
    const { theme } = useThemeContext(); // 'light' | 'dark'

    const { isLoading, visualization, setVisualization } = useVisualization({
        canvas,
    });

    const [draft, setDraft] = useState<BasicVisualization | undefined>();

    const [searchParams, setSearchParams] = useSearchParams();
    const childrenVisualizationFromParam: ChildVisualization =
        CHILDREN_VISUALIZATION_PARAM_MAP[
            (searchParams.get(VIEW_PARAM_QUERY_KEY) as string) || "feed"
        ];

    const setChildrenVisualizationParam = (
        childrenVisualization: ChildVisualization
    ) => {
        const newParams = new URLSearchParams(searchParams);
        if (childrenVisualization != null) {
            const newView =
                CHILDREN_VISUALIZATION_PARAM_MAP_REVERSE[childrenVisualization];
            newParams.set(VIEW_PARAM_QUERY_KEY, newView);
            if (childrenVisualization === ChildVisualization.CHAT) {
                // if we are in chat mode, remove the filter param
                newParams.delete(STREAM_QUERY_PARAMS.SETTINGS);
            }
        } else {
            newParams.delete(VIEW_PARAM_QUERY_KEY);
        }

        console.log("SET PARAMS", childrenVisualization, newParams.toString());
        setSearchParams(newParams, { replace: true });
    };

    useEffect(() => {
        // if we have a draft, update the children visualization param
        if (draft) {
            setChildrenVisualizationParam(draft.view);
        } else if (visualization) {
            setChildrenVisualizationParam(
                (visualization as BasicVisualization).view
            );
        }
    }, [visualization, draft]);

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
                view: d.view,
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
                    view:
                        childrenVisualizationFromParam ??
                        ChildVisualization.FEED,
                })
            );
        }
    };

    useEffect(() => {
        // if we have a draft, update the visualization in the canvas
        canvas && createDraft(true); // replace the current draft with the new one
    }, [childrenVisualizationFromParam, visualization, canvas]);

    /* const navigate = useNavigate(); */

    /*   const navigateToNarrative = async () => {
          // navigate to the first leaf that is of narrative type
          let root = canvases[canvases.length - 1];
          let feedContext = await root.getFeedContext();
          if (feedContext !== root) {
              navigate(getCanvasPath(feedContext));
          }
      }; */

    const value = useMemo<VisualizationCtx>(
        () => ({
            canvas,
            isLoading,
            visualization: (draft || visualization) as BasicVisualization,
            draft,
            createDraft,
            updateDraft,
            saveDraft,
            cancelDraft,
            /*      navigateToNarrative, */
        }),
        [canvas, isLoading, visualization, draft]
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
