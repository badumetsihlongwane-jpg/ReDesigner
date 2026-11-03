/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./popup.html"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff1f2',
          100: '#ffe4e6',
          500: '#e50914',
          600: '#dc2626',
          700: '#b91c1c',
          900: '#7f1d1d',
        },
        cinema: {
          base: '#0f0f11',
          card: '#18181c',
          hover: '#24242b',
          border: 'rgba(255, 255, 255, 0.08)'
        }
      }
    },
  },
  plugins: [],
}
