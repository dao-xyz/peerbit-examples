import React, { useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Switch from "@radix-ui/react-switch";
import {
    ModedBackground,
    SimpleThemePalette,
    ModedThemePalette,
    BasicVisualization,
} from "@giga-app/interface";

import { MdOutlineLightMode, MdOutlineDarkMode } from "react-icons/md";
import { ColorResult, SketchPicker, TwitterPicker } from "react-color";

export const ColorSwatchPicker: React.FC<{
    /** Current hex value, e.g. "#ff00aa" */
    color: string;
    /** Called when the user picks a colour */
    onChange: (colorResult: ColorResult) => void;
    /** Optional: size of the square swatch (px) */
    size?: number;
    /** Optional. Disable alpha channel (default: false) */
    disableAlpha?: boolean;
}> = ({ color, onChange, size = 20, disableAlpha }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    /* Close when clicking outside */
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        window.addEventListener("mousedown", onClick);
        return () => window.removeEventListener("mousedown", onClick);
    }, [open]);

    return (
        <div className="relative inline-block" ref={ref}>
            {/* the tiny preview square */}
            <button
                type="button"
                aria-label="Choose colour"
                className="rounded border border-neutral-300 dark:border-neutral-600"
                style={{
                    background: color,
                    width: size,
                    height: size,
                }}
                onClick={() => setOpen(!open)}
            />

            {/* popover with the sketch picker */}
            {open && (
                <div className="absolute z-50 mt-2">
                    {isTouchDevice ? (
                        <TwitterPicker
                            color={color}
                            onChange={(c: ColorResult) => onChange(c)}
                        />
                    ) : (
                        <SketchPicker
                            color={color}
                            disableAlpha={disableAlpha}
                            onChange={(c: ColorResult) => onChange(c)}
                        />
                    )}
                </div>
            )}
        </div>
    );
};

type Mode = "light" | "dark";

/* ─────────── Background editor (Tabs) ─────────── */

import {
    StyledBackground,
    CanvasBackground,
    BackGroundTypes,
} from "@giga-app/interface";
import { useThemeContext } from "../../theme/useTheme";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { isTouchDevice } from "../../utils/device";
import { useVisualizationContext } from "./CustomizationProvider";

/* helpers that emit CSS strings */
/* tiny helpers to build CSS strings */
const cssColour = (hex: string) => `background-color:${hex}`;

export const cssUrl = (
    url: string,
    options: {
        fixed?: boolean;
        repeatY?: boolean;
        fill?: string;
    } = {}
) => {
    const { fixed = false, repeatY = false, fill = "#000" } = options;

    /* image rules (always first) */
    const imageDecl = [
        `background-image:url("${url}")`,
        "background-position:top center",
        "background-size:100% auto",
        `background-repeat:${repeatY ? "repeat-y" : "no-repeat"}`,
        fixed ? "background-attachment:fixed" : "",
    ]
        .filter(Boolean)
        .join(";");

    /* solid colour to occupy leftover height (only if no-repeat) */
    const fillDecl = repeatY ? "" : `background-color:${fill}`;

    /* final CSS string (semicolon-terminated) */
    return `${imageDecl};${fillDecl}`.trim();
};

const isUrl = (url: string) => {
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
};

const extractFill = (css: string) => {
    const fill =
        css.match(/background-color\s*:\s*([^;]+)/i)?.[1].trim() ?? "#000000";
    return fill;
};

export function parseUrlBg(css: string) {
    /* url("…") — accepts quotes or none */
    const url =
        css.match(
            /background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i
        )?.[1] ?? "";

    const fixed = /background-attachment\s*:\s*fixed/i.test(css);

    const repeat =
        css.match(/background-repeat\s*:\s*(\S+)/i)?.[1].toLowerCase() ??
        "no-repeat";
    const repeatY = repeat === "repeat-y";

    const fill = extractFill(css);

    return { url, fixed, repeatY, fill };
}

//  background - attachment: fixed;
/* map background object → tab key */
const tabOf = (bg?: BackGroundTypes): string =>
    bg instanceof StyledBackground && bg.css.startsWith("background-color:")
        ? "color"
        : bg instanceof StyledBackground &&
          bg.css.startsWith("background-image:url")
        ? "url"
        : bg instanceof CanvasBackground
        ? "canvas"
        : "custom"; // default to custom if unrecognised

export const BackgroundEditor: React.FC<{
    bg: BackGroundTypes | undefined;
    setBackground: (b: BackGroundTypes | undefined) => void;
}> = ({ bg, setBackground }) => {
    const [url, setUrl] = useState("");
    const [fixed, setFixed] = useState(false);
    const [repeatY, setRepeat] = useState(true);
    const [fill, setFill] = useState("#000000");

    /* ---------------------------------------------------------------
     * EFFECT: whenever the background *object* represents a URL style
     *         (and user switches back to the “URL” tab), extract its
     *         pieces into the local state so the controls show
     *         the current values instead of starting blank.
     * ------------------------------------------------------------- */
    useEffect(() => {
        if (!(bg instanceof StyledBackground)) return;
        if (tabOf(bg) !== "url") return; // only care for URL tab

        const {
            url: newUrl,
            fixed: newFixed,
            fill: newFill,
            repeatY: newRepeatY,
        } = parseUrlBg(bg.css);
        if (newUrl !== url) setUrl(newUrl);
        if (newFixed !== fixed) setFixed(newFixed);
        if (newRepeatY !== repeatY) setRepeat(newRepeatY);
        if (newFill !== fill) setFill(newFill);
    }, [bg]); /* ← re-run when bg object changes */

    const commitUrl = () => {
        console.log({
            url,
            fixed,
            repeatY,
            fill,
        });
        setBackground(
            new StyledBackground({ css: cssUrl(url, { fixed, repeatY, fill }) })
        );
    };

    useEffect(() => {
        if (isUrl(url)) {
            commitUrl();
        }
    }, [url, fixed, repeatY, fill]);

    return (
        <Tabs.Root
            value={tabOf(bg)}
            onValueChange={(v) => {
                if (v === "color")
                    setBackground(
                        new StyledBackground({ css: cssColour("#ffffff") })
                    );
                if (v === "url") commitUrl();
                if (v === "canvas")
                    setBackground(
                        new CanvasBackground({ ref: { canvas: "" } } as any)
                    );
                if (v === "custom")
                    setBackground(new StyledBackground({ css: "" }));
            }}
            className="flex flex-col gap-3"
        >
            <Tabs.List className="flex gap-2">
                {(
                    ["color", "url", /* TODO  "canvas", */ "custom"] as const
                ).map((t) => (
                    <Tabs.Trigger
                        key={t}
                        value={t}
                        className="px-3 py-1 rounded text-xs border
              data-[state=active]:bg-primary-300 data-[state=active]:dark:bg-primary-500 data-[state=active]:text-white"
                    >
                        {t === "color"
                            ? "Colour"
                            : t === "url"
                            ? "Image URL"
                            : /*  TODO t === "canvas" ? "Canvas" :  */ "Custom CSS"}
                    </Tabs.Trigger>
                ))}
            </Tabs.List>

            <Tabs.Content value="color">
                <ColorSwatchPicker
                    color={extractFill(
                        bg instanceof StyledBackground ? bg.css : ""
                    )}
                    onChange={(e) =>
                        setBackground(
                            new StyledBackground({ css: cssColour(e.hex) })
                        )
                    }
                />
            </Tabs.Content>

            <Tabs.Content value="url">
                <div className="flex flex-col gap-3 text-xs">
                    {/* URL input */}
                    <input
                        type="text"
                        className="input input-sm w-full"
                        placeholder="https://ex.switch-rootample.com/banner.jpg"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                    />

                    {/* Switches row */}
                    <div className="flex flex-col sm:flex-row sm:gap-6 gap-3">
                        {/* Fixed */}
                        <label className="inline-flex items-center gap-2">
                            <Switch.Root
                                checked={fixed}
                                onCheckedChange={setFixed}
                                className="switch-root"
                            >
                                <Switch.Thumb className="switch-thumb" />
                            </Switch.Root>
                            Fixed
                        </label>

                        {/* Repeat-Y */}
                        <label className="inline-flex items-center gap-2">
                            <Switch.Root
                                checked={repeatY}
                                onCheckedChange={setRepeat}
                                className="switch-root"
                            >
                                <Switch.Thumb className="switch-thumb" />
                            </Switch.Root>
                            Repeat-Y
                        </label>
                    </div>

                    {/* Fill colour when Repeat-Y off */}
                    {!repeatY && (
                        <div className="flex items-center gap-2">
                            Fill&nbsp;color
                            <ColorSwatchPicker
                                color={fill}
                                onChange={(e) => setFill(e.hex)}
                            />
                        </div>
                    )}
                </div>
            </Tabs.Content>

            {/*  TODO
            <Tabs.Content value="canvas">
                <p className="text-xs text-neutral-500">Pick a post in the feed…</p>
            </Tabs.Content> */}

            <Tabs.Content value="custom">
                <textarea
                    rows={4}
                    className="textarea textarea-bordered w-full p-2"
                    placeholder="Any CSS…"
                    defaultValue={bg instanceof StyledBackground ? bg.css : ""}
                    onBlur={(e) =>
                        setBackground(
                            new StyledBackground({ css: e.target.value })
                        )
                    }
                />
            </Tabs.Content>
        </Tabs.Root>
    );
};

/* ─────────── Mode editor (Light / Dark) ─────────── */
const ModeEditor: React.FC<{
    mode: Mode;
    visualization: BasicVisualization;
    onCommit: (visualization: BasicVisualization) => void;
}> = ({ mode, visualization: visualization, onCommit }) => {
    const bgWrap = visualization.background as ModedBackground;
    const palWrap = visualization.palette as ModedThemePalette;

    const bg = mode === "light" ? bgWrap?.light : bgWrap?.dark;
    const setBg = (b: BackGroundTypes | undefined) => {
        if (mode === "light") bgWrap.light = b!;
        else bgWrap.dark = b;

        onCommit(visualization);
    };

    const pal =
        mode === "light"
            ? (palWrap?.light as SimpleThemePalette)
            : (palWrap?.dark as SimpleThemePalette | undefined);
    const setPal = (p?: SimpleThemePalette) => {
        if (mode === "light") palWrap.light = p!;
        else palWrap.dark = p;
    };

    return (
        <div className="space-y-4">
            <BackgroundEditor bg={bg} setBackground={setBg} />

            <fieldset className="space-y-3">
                <legend className="font-bold text-sm">Theme colours</legend>
                {pal ? (
                    <div className="flex gap-3 items-center">
                        {(["primary", "secondary", "neutral"] as const).map(
                            (slot) => (
                                <ColorSwatchPicker
                                    key={slot}
                                    color={(pal as any)[slot]}
                                    onChange={(e) => {
                                        (pal as any)[slot] = e.hex;
                                        setPal(pal);
                                        onCommit(visualization);
                                    }}
                                />
                            )
                        )}
                    </div>
                ) : (
                    <p className="text-xs text-neutral-500">
                        Dark mode disabled — enable toggle
                    </p>
                )}
            </fieldset>
        </div>
    );
};

/* ─────────── Main panel ─────────── */
export const CustomizationSettings = (props: { onClose: () => void }) => {
    const { saveDraft, updateDraft, draft } = useVisualizationContext();

    const { setTheme, theme } = useThemeContext();

    const [tab, _setTab] = useState<Mode>(theme);

    const setTab = (v: Mode) => {
        _setTab(v);
        setTheme(v === "dark" ? "dark" : "light");
    };
    const hasDark =
        (draft?.background as ModedBackground)?.dark ||
        (draft?.palette as ModedThemePalette)?.dark;

    useEffect(() => {
        if (!hasDark && theme === "dark") {
            setTheme("light");
        }
    }, [hasDark]);

    const toggleDark = () => {
        if (!draft) return;
        const bg = draft.background as ModedBackground;
        const pal = draft.palette as ModedThemePalette;
        if (hasDark) {
            // undo setting tark mode
            bg.dark = undefined;
            pal.dark = undefined;
            setTab("light");
            setTheme("light");
        } else {
            bg.dark = new StyledBackground({ css: "background-color:#000000" });
            pal.dark = deserialize(serialize(pal.light), SimpleThemePalette);
            setTab("dark");
            setTheme("dark");
        }
    };

    return (
        <>
            <Tabs.Root
                value={tab}
                onValueChange={(v) => setTab(v as Mode)}
                className="space-y-6"
            >
                {/* header */}
                <header className="flex justify-between items-center">
                    <Tabs.List className="flex gap-2">
                        <Tabs.Trigger
                            value="light"
                            className={`btn btn-icon btn-xs ${
                                tab === "light"
                                    ? "bg-neutral-300 dark:bg-neutral-700"
                                    : ""
                            }`}
                        >
                            <MdOutlineLightMode size={20} />
                        </Tabs.Trigger>
                        {hasDark && (
                            <Tabs.Trigger
                                value="dark"
                                className={`btn btn-icon btn-xs ${
                                    tab === "dark"
                                        ? "bg-neutral-300 dark:bg-neutral-700"
                                        : ""
                                }`}
                            >
                                <MdOutlineDarkMode size={20} />
                            </Tabs.Trigger>
                        )}
                    </Tabs.List>

                    {/* dark mode switch */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs">Custom dark mode</span>
                        <Switch.Root
                            checked={!!hasDark}
                            onCheckedChange={toggleDark}
                            className="switch-root"
                        >
                            <Switch.Thumb className="switch-thumb" />
                        </Switch.Root>
                    </div>
                </header>

                {/* light */}
                {theme === "light" ? (
                    <Tabs.Content value="light" forceMount>
                        <ModeEditor
                            mode="light"
                            visualization={draft}
                            onCommit={updateDraft}
                        />
                    </Tabs.Content>
                ) : (
                    <Tabs.Content value="dark" forceMount>
                        <ModeEditor
                            mode="dark"
                            visualization={draft}
                            onCommit={updateDraft}
                        />
                    </Tabs.Content>
                )}

                <div className="flex gap-2 w-full">
                    <div className="flex flex-row ml-auto">
                        <button
                            className="btn btn-sm btn-primary"
                            disabled={!draft}
                            onClick={() => {
                                if (!draft) return;
                                saveDraft();
                                props.onClose();
                            }}
                        >
                            Save
                        </button>

                        <button
                            className="btn btn-sm"
                            disabled={!draft}
                            onClick={props.onClose}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </Tabs.Root>
        </>
    );
};
