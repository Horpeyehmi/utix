import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./core/**/*.{js,ts,jsx,tsx,mdx}",
    "./features/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          950: "#090a12",
          900: "#101321",
          800: "#171b2d",
          700: "#222842"
        },
        stellar: {
          cyan: "#54d2ff",
          violet: "#8b5cf6",
          green: "#62d79b",
          amber: "#f6c85f"
        }
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(84, 210, 255, 0.14), 0 20px 60px rgba(0, 0, 0, 0.34)"
      }
    }
  },
  plugins: []
};

export default config;
