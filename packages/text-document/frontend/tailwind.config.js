/** @type {import('tailwindcss').Config} */

import colors from "tailwindcss/colors";

export default {
    important: true,
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        colors: {
            primary: colors.blue,
            secondary: colors.yellow,
            neutral: colors.gray,
        },
    },
    plugins: [],
};
