import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function previewSecurityHeaders(): Record<string, string> {
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vercel.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const block = config.headers?.find((entry) => entry.source === '/(.*)');
  return Object.fromEntries((block?.headers ?? []).map((header) => [header.key, header.value]));
}

const LT_HEAVY = [
  'index.ts', 'theory.ts', 'grammar.ts', 'extraExamples.ts', 'dictation.ts', 'builder.ts',
  'quizzes.ts', 'pathPractice.ts', 'achievements.ts', 'plan.ts', 'appendLexicon.ts', 'appendPacks.ts',
];

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: null,
        manifest: {
          name: 'Language Trainer',
          short_name: 'LangTrainer',
          description: 'Интерактивный языковой тренажёр с интервальным повторением, грамматикой и AI-собеседником.',
          lang: 'ru',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#141820',
          background_color: '#141820',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2,webmanifest}'],
        },
        devOptions: {
          enabled: true,
          type: 'module',
          navigateFallback: 'index.html',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Помощник предзагрузки Vite нужен всем ленивым import(). Без своего чанка Rollup кладёт его
            // в первый попавшийся чанк (был data-lt), и тогда этот чанк становится статической зависимостью index.
            if (id.includes('vite/preload-helper')) return 'vendor-preload';
            // НЕ объединяй тяжёлые файлы в один чанк
            if (id.includes('/vocabBoost') || id.includes('/lessonsData')) return undefined;
            // English glosses stay in their own chunk: loaded only by import() when content language is en.
            // overlay.ts pulls in pilot.ts and every file in en/batches/, so all of them must land here.
            if (id.includes('/src/data/lt/en/overlay') || id.includes('/src/data/lt/en/pilot') || id.includes('/src/data/lt/en/batches/')) return 'data-lt-en';
            // Shared by the English and Lithuanian packs. Keeping it here avoids a circular chunk.
            if (id.includes('/src/data/register')) return 'data-register';
            // Счётчики (deviceCounters) и статистика нужны стартовому коду и английским данным одновременно.
            // Без своего чанка Rollup кладёт их в data-en, и тот становится статической зависимостью
            // index.html — тогда тяжёлые языковые данные грузятся на первой отрисовке (F-08).
            if (id.includes('/src/utils/deviceCounters') || id.includes('/src/utils/statsHelpers')) return 'data-counters';
            if (id.includes('/src/data/en/')) return 'data-en';
            // Лексикон нужен и английскому пакету (collocationItems): свой чанк, чтобы data-en не тянул весь data-lt.
            if (id.includes('/src/data/lt/lexicon')) return 'data-lt-lexicon';
            if (id.includes('/src/data/lt/constitution/')) return 'data-constitution-free';
            if (id.includes('/src/data/lt/')) {
              // F-08: только тяжёлое содержимое курса (теория, грамматика, примеры, сборка пакета)
              // грузится через import('./lt'). Лёгкое ядро (путь, наборы, диалоги, подписи), которое нужно
              // основному бандлу, живёт отдельно, иначе статический импорт тянул весь data-lt в первую загрузку.
              return LT_HEAVY.some(name => id.includes(`/src/data/lt/${name}`)) ? 'data-lt' : 'data-lt-core';
            }
            if (id.includes('/node_modules/@firebase/util/') || id.includes('/node_modules/@firebase/component/') || id.includes('/node_modules/@firebase/logger/')) return 'vendor-firebase-core';
            if (id.includes('/node_modules/@firebase/firestore') || id.includes('/node_modules/firebase/firestore')) return 'vendor-firebase-firestore';
            if (id.includes('/node_modules/@firebase/auth') || id.includes('/node_modules/firebase/auth')) return 'vendor-firebase-auth';
            // App Check грузится только динамическим import() из src/utils/appCheck.ts: свой чанк,
            // иначе правило '@firebase/app' ниже затягивает его в предзагружаемый vendor-firebase-app.
            if (id.includes('/node_modules/@firebase/app-check/') || id.includes('/node_modules/firebase/app-check')) return 'vendor-firebase-appcheck';
            if (id.includes('/node_modules/@firebase/app') || id.includes('/node_modules/firebase/app')) return 'vendor-firebase-app';
            if (id.includes('/node_modules/firebase/')) return 'vendor-firebase-shared';
            if (id.includes('/node_modules/lucide-react/')) return 'vendor-icons';
            if (id.includes('/node_modules/motion/')) return 'vendor-motion';
            if (id.includes('/node_modules/react-markdown/') || id.includes('/node_modules/remark-gfm/')) return 'vendor-markdown';
          }
        }
      }
    },
    optimizeDeps: {
      // virtual:pwa-register (src/main.tsx) imports workbox-window, but Vite's dependency scan cannot see
      // through virtual modules. Without this, the dev server finds it only on the first page load,
      // re-bundles deps and force-reloads; pages already running then mix two React copies
      // ("Invalid hook call") and render nothing. That made the first e2e tests flaky on a cold server.
      include: ['workbox-window'],
    },
    preview: {
      headers: previewSecurityHeaders(),
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
