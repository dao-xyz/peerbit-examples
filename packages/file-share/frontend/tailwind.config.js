/** @type {import('tailwindcss').Config} */

import colors from "tailwindcss/colors";

export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        colors: {
            primary: colors.blue,
            secondary: colors.yellow,
            neutral: colors.neutral,
            white: colors.white,
            black: colors.black,
            slate: colors.slate,
        },
    },
    darkMode: ["class", "[class~='dark']"],
    plugins: [],
};
