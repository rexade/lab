/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#080808',
        surface: '#0f0f0f',
        surface2: '#161616',
        surface3: '#1e1e1e',
        border: 'rgba(255,255,255,0.07)',
        accent: '#22d3ee',
        'accent-dim': 'rgba(34,211,238,0.12)',
        'accent-glow': 'rgba(34,211,238,0.4)',
        warm: '#fb923c',
        danger: '#f87171',
        muted: '#475569',
        subtle: '#2d3748',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(34,211,238,0.25), 0 0 8px rgba(34,211,238,0.15)',
        'glow-sm': '0 0 12px rgba(34,211,238,0.2)',
        'glow-warm': '0 0 16px rgba(251,146,60,0.3)',
        panel: '0 4px 32px rgba(0,0,0,0.6)',
        card: '0 2px 16px rgba(0,0,0,0.5)',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan': 'scan 3s linear infinite',
        'fade-up': 'fade-up 0.4s ease-out',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: 1, boxShadow: '0 0 8px rgba(34,211,238,0.3)' },
          '50%': { opacity: 0.7, boxShadow: '0 0 20px rgba(34,211,238,0.6)' },
        },
        'scan': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-up': {
          '0%': { opacity: 0, transform: 'translateY(8px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
