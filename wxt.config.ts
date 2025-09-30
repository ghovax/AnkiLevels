import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Anki Levels',
    description: 'Highlight words on web pages based on your Anki card difficulty levels',
    permissions: ['storage'],
  },
});
