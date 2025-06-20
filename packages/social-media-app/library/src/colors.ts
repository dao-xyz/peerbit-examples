import { field, variant, fixedArray, option } from "@dao-xyz/borsh";
import { StaticImage } from "./static";
import { CanvasAddressReference } from "./content";

// ───── Helpers ────────────────────────────────────────────────────────────────
const ramp: Record<number, number> = {
    50: 0.95,
    100: 0.9,
    200: 0.8,
    300: 0.7,
    400: 0.6,
    500: 0.5,
    600: 0.4,
    700: 0.3,
    800: 0.2,
    900: 0.15,
    950: 0.1,
};
const hex = (n: number) => n.toString(16).padStart(2, "0");

function hslToHex(h: number, s: number, l: number) {
    s /= 100;
    l /= 100;
    h /= 360;
    const f = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = f(p, q, h + 1 / 3);
    const g = f(p, q, h);
    const b = f(p, q, h - 1 / 3);
    return `#${hex(Math.round(r * 255))}${hex(Math.round(g * 255))}${hex(
        Math.round(b * 255)
    )}`;
}

function hexToHsl(hexColor: string): [number, number, number] {
    const n = parseInt(hexColor.replace("#", ""), 16);
    const r = (n >> 16) & 255,
        g = (n >> 8) & 255,
        b = n & 255;
    const rp = r / 255,
        gp = g / 255,
        bp = b / 255;
    const max = Math.max(rp, gp, bp),
        min = Math.min(rp, gp, bp);
    let h = 0,
        s = 0,
        l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case rp:
                h = (gp - bp) / d + (gp < bp ? 6 : 0);
                break;
            case gp:
                h = (bp - rp) / d + 2;
                break;
            default:
                h = (rp - gp) / d + 4;
        }
        h *= 60;
    }
    return [h, s * 100, l * 100];
}

// ───── Theme palette (one mode) ───────────────────────────────────────────────
/* ─────────────────── Abstract palette (one mode) ─────────────────────── */
export abstract class AbstractThemePalette {}

/* ─────────── 0. simple HSL-ramp palette (single mode) ─────────────────── */
@variant(0)
export class SimpleThemePalette extends AbstractThemePalette {
    @field({ type: "string" })
    primary: string;

    @field({ type: "string" })
    secondary: string;

    @field({ type: "string" })
    neutral: string;

    constructor(
        p: { primary?: string; secondary?: string; neutral?: string } = {}
    ) {
        super();
        this.primary = p?.primary ?? "#1e88e5"; // default blue
        this.secondary = p?.secondary ?? "#ff4081"; // default pink
        this.neutral = p?.neutral ?? "#9e9e9e"; // default grey
    }

    shades(base: string) {
        const [h, s] = hexToHsl(base);
        const out: Record<number, string> = {};
        for (const k in ramp) out[+k] = hslToHex(h, s, ramp[+k] * 100);
        return out;
    }
}

@variant(0)
export class ModedThemePalette {
    @field({ type: SimpleThemePalette })
    light: SimpleThemePalette;

    @field({ type: option(SimpleThemePalette) })
    dark?: SimpleThemePalette;

    constructor(p: { light: SimpleThemePalette; dark?: SimpleThemePalette }) {
        this.light = p.light;
        this.dark = p.dark;
    }
}
