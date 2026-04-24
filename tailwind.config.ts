import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#09090b',
          card: '#18181b',
          input: '#27272a',
          border: '#3f3f46',
        },
      },
    },
  },
  plugins: [],
};

export default config;
