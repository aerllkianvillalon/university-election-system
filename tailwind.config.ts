import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#11110f',
        paper: '#fbfaf6',
        signal: '#FFE600',
        muted: '#6f6f69',
        line: '#deddd5',
      },
      fontFamily: {
        display: ['Montserrat', 'Arial', 'sans-serif'],
        sans: ['Inter', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        signal: '0 0 42px rgba(255,230,0,.22)',
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
