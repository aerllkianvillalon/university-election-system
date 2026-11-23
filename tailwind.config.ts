import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1b2a31',
        paper: '#f5f8f7',
        accent: '#0f766e',
        muted: '#51636b',
        line: '#dbe4e4',
      },
      fontFamily: {
        display: ['Fraunces Variable', 'Georgia', 'serif'],
        sans: ['Inter', 'Arial', 'sans-serif'],
      },
      minHeight: {
        touch: '48px',
      },
      minWidth: {
        touch: '48px',
      },
    },
  },
  plugins: [],
} satisfies Config;
