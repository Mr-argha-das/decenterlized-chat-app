import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        rc: {
          teal: "#00a884",
          tealDark: "#008069",
          bgLight: "#f0f2f5",
          bgDark: "#111b21",
          panelLight: "#ffffff",
          panelDark: "#202c33",
          headerLight: "#f0f2f5",
          headerDark: "#202c33",
          chatLight: "#efeae2",
          chatDark: "#0b141a",
          outLight: "#d9fdd3",
          outDark: "#005c4b",
          inLight: "#ffffff",
          inDark: "#202c33",
        },
      },
    },
  },
  plugins: [],
};

export default config;
