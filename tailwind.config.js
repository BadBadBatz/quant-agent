/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#080808',
        surface: '#111111',
        border: '#1e1e1e',
        muted: '#444444',
        dim: '#888888',
        text: '#e8e8e8',
        green: {
          DEFAULT: '#00d97e',
          dim: '#00d97e33',
        },
        red: {
          DEFAULT: '#ff4444',
          dim: '#ff444433',
        },
        amber: {
          DEFAULT: '#f59e0b',
          dim: '#f59e0b33',
        },
        accent: '#5b8ef7',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
