/** @type {import('tailwindcss').Config} */
export default {
  content: [
    // Django templates
    "../project/**/*.html",
    "../frontend/templates/**/*.html",
    // Vite source
    "./src/**/*.{js,ts,jsx,tsx,vue,html}",
  ],
  theme: {
    extend: {
      fontFamily: {
        inter: ["Inter", "sans-serif"],
      },
      colors: {
        primary: {
          50: "#f0f4ff",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
        },
      },
    },
  },
  plugins: [],
};
