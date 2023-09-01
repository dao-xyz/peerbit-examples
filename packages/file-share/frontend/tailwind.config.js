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
            green: colors.green,
            red: colors.red,
            slate: colors.slate,
        },
    },
    darkMode: ["class", "[class~='dark']"],
    plugins: [],
};
