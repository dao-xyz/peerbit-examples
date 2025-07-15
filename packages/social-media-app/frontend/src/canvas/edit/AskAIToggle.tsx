/* ── NEW imports (put with the others at top of file) ─────────── */
import { motion } from "framer-motion";
import { MdOutlineSmartToy, MdSmartToy } from "react-icons/md";
import * as Toggle from "@radix-ui/react-toggle";

/* ----------------------------------------------------------------
   Fancy Ask-AI toggle
   ---------------------------------------------------------------- */
export const AiToggle = ({
    pressed,
    disabled,
    onPressedChange,
}: {
    pressed: boolean;
    disabled: boolean;
    onPressedChange: (val: boolean) => void;
}) => {
    const color = pressed
        ? "bg-primary-400 dark:bg-primary-500 text-white "
        : "text-neutral-700 dark:text-neutral-200";

    return (
        <Toggle.Root
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            aria-label="Ask AI toggle"
            /* Tailwind utilities for the pill */
            className={`
      relative btn inline-flex items-center gap-2 rounded-full px-3 py-1
      text-sm font-medium transition-colors duration-200
      ${pressed ? "shadow-md" : ""}
      focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary-400 dark:focus-visible:ring-primary-500
      ${color}
    `}
        >
            {/* Spinning robot icon when active */}
            <motion.span
                animate={{
                    rotate: pressed ? 360 : 0,
                    scale: pressed ? 1.1 : 1,
                }}
                transition={{
                    type: "spring",
                    stiffness: 260,
                    damping: 18,
                }}
                className="flex"
            >
                <MdOutlineSmartToy className={"w-4 h-4 " + color} />
            </motion.span>

            {/* Label changes subtly */}
            <span className={"text-nowrap " + color}>
                {" "}
                {pressed ? "AI On" : "Ask AI"}
            </span>
        </Toggle.Root>
    );
};
