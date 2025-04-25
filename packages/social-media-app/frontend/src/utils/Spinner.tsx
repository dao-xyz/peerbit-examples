export const Spinner = () => {
    const radius = 45; // Based on a 100x100 viewBox
    const strokeWidth = 10;
    const circumference = 2 * Math.PI * radius; // Total circle length
    const dashLength = 0.5 * circumference; // Visible dash length

    return (
        <svg
            aria-hidden="true"
            className="w-6 h-6 animate-spin text-neutral-600 dark:text-neutral-400"
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <defs>
                {/* Define a gradient that fades from opaque to transparent */}
                <linearGradient
                    id="spinnerGradient"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="0%"
                >
                    <stop
                        offset="0%"
                        stopColor="currentColor"
                        stopOpacity="1"
                    />
                    <stop
                        offset="100%"
                        stopColor="currentColor"
                        stopOpacity="0"
                    />
                </linearGradient>
            </defs>

            {/* Background Circle (not visible) */}
            <circle
                cx="50"
                cy="50"
                r={radius}
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="opacity-0"
            />

            {/* Arc Spinner with fading gradient */}
            <circle
                cx="50"
                cy="50"
                r={radius}
                stroke="url(#spinnerGradient)"
                strokeWidth={strokeWidth}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeDashoffset="0"
                strokeLinecap="round"
            />
        </svg>
    );
};
