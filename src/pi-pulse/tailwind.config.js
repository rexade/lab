/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--bg)',
        line: 'var(--line)',
        fg: 'var(--text)',
        fg2: 'var(--text-2)',
        fg3: 'var(--text-3)',
        fg4: 'var(--text-4)',
        accent: 'var(--accent)',
        run: 'var(--run)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        fail: 'var(--fail)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        label: ['11px', { lineHeight: '14px', letterSpacing: '0.14em' }],
      },
      borderRadius: {
        panel: '22px',
      },
    },
  },
  plugins: [],
}
