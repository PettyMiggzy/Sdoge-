import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // SDOGE Launchpad look (the owner's mockup): near-black navy, electric
        // USDC blue, doge gold, violet Arc glow.
        bg: '#040A18', panel: '#0A1530', panel2: '#0F1E40', line: '#16305E', line2: '#21457F',
        text: '#F2F6FF', muted: '#9FB0D0', dim: '#61739A', cream: '#FFF8EA',
        brand: { DEFAULT: '#1F7BFF', hi: '#4DA3FF', lo: '#1558C0' },
        gold: { DEFAULT: '#F5B82E', hi: '#FFD66B' },
        violet: '#8B6BFF',
        up: '#2BD47D', down: '#FF5C5C',
      },
      backgroundImage: {
        'sdoge-grad': 'linear-gradient(180deg,#3B95FF 0%,#1668E6 100%)',
        'sdoge-grad-v': 'linear-gradient(180deg,#4DA3FF 0%,#1F7BFF 55%,#0F1E40 100%)',
        'sdoge-gold': 'linear-gradient(180deg,#FFE08A 0%,#F5B82E 100%)',
        'sdoge-text': 'linear-gradient(90deg,#FFE08A 0%,#4DA3FF 100%)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        marker: ['var(--font-marker)', 'cursive'],
      },
      borderRadius: { xl2: '14px', xl3: '18px' },
      boxShadow: {
        card: '0 0 0 1px rgba(77,163,255,0.05), 0 18px 40px -18px rgba(0,0,0,0.75)',
        glow: '0 0 0 2px rgba(77,163,255,.45)',
        btn: '0 8px 22px -8px rgba(31,123,255,.8)',
        icon: '0 0 24px rgba(31,123,255,.45)',
      },
    },
  },
  plugins: [],
} satisfies Config;
