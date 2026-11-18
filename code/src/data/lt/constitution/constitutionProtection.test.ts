import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  constitutionChapters,
  constitutionQuestions,
  constitutionMetadata,
  constitutionOutline,
} from './index';
import { constitutionMetadata as lightMetadata } from './meta';
import { constitutionOutline as standaloneOutline } from './outline';

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      walk(full, acc);
      continue;
    }
    if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
}

function extractImportSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const regexes = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export function resolveTarget(file: string, root: string, spec: string): string | null {
  let targetPath: string;
  if (spec.startsWith('.')) {
    targetPath = resolve(dirname(file), spec);
  } else if (spec.startsWith('@/')) {
    // vite.config.ts:62 and tsconfig.json:18-21 map '@/' to repository root.
    targetPath = resolve(root, spec.slice(2));
  } else {
    return null;
  }
  let relTarget = relative(root, targetPath).replace(/\\/g, '/');
  // Strip trailing extension if present (.ts, .tsx, .js, .mjs)
  relTarget = relTarget.replace(/\.(ts|tsx|js|mjs)$/, '');
  return relTarget;
}

describe('Import path resolver (resolveTarget)', () => {
  const root = fileURLToPath(new URL('../../../..', import.meta.url));
  const testFile = join(root, 'src', 'data', 'lt', 'constitution', 'meta.ts');
  const chFile = join(root, 'src', 'data', 'lt', 'constitution', 'chapters', 'ch01.ts');

  it('resolves relative imports with and without extension', () => {
    assert.strictEqual(
      resolveTarget(testFile, root, './index'),
      'src/data/lt/constitution/index',
    );
    assert.strictEqual(
      resolveTarget(testFile, root, './index.ts'),
      'src/data/lt/constitution/index',
    );
    assert.strictEqual(
      resolveTarget(chFile, root, '../index'),
      'src/data/lt/constitution/index',
    );
  });

  it('maps @/ alias to repository root correctly', () => {
    assert.strictEqual(
      resolveTarget(testFile, root, '@/src/data/lt/constitution/index'),
      'src/data/lt/constitution/index',
    );
    assert.strictEqual(
      resolveTarget(testFile, root, '@/src/data/lt/constitution/index.ts'),
      'src/data/lt/constitution/index',
    );
    assert.strictEqual(
      resolveTarget(testFile, root, '@/src/data/lt/constitution/chapters/ch03'),
      'src/data/lt/constitution/chapters/ch03',
    );
  });

  it('returns null for external packages', () => {
    assert.strictEqual(resolveTarget(testFile, root, 'react'), null);
    assert.strictEqual(resolveTarget(testFile, root, 'lucide-react'), null);
  });
});

describe('Constitution drift test', () => {
  it('meta.ts totals match real constitution data', () => {
    assert.strictEqual(lightMetadata.totalChapters, constitutionChapters.length);
    assert.strictEqual(lightMetadata.totalArticles, 154);
    assert.strictEqual(
      lightMetadata.totalArticles,
      constitutionChapters.reduce((acc, ch) => acc + ch.articles.length, 0),
    );
    assert.strictEqual(lightMetadata.totalQuestions, 114);
    assert.strictEqual(lightMetadata.totalQuestions, constitutionQuestions.length);
    assert.strictEqual(constitutionMetadata.totalChapters, 15);
    assert.strictEqual(constitutionMetadata.totalArticles, 154);
    assert.strictEqual(constitutionMetadata.totalQuestions, 114);
  });

  it('outline.ts matches real chapters and questions exactly', () => {
    assert.strictEqual(standaloneOutline.length, 15);
    assert.strictEqual(constitutionOutline.length, 15);

    const qCountByChapter = new Map<string, number>();
    for (const q of constitutionQuestions) {
      qCountByChapter.set(q.chapterId, (qCountByChapter.get(q.chapterId) || 0) + 1);
    }

    for (let i = 0; i < 15; i++) {
      const item = standaloneOutline[i];
      const ch = constitutionChapters[i];
      assert.strictEqual(item.id, ch.id);
      assert.strictEqual(item.number, ch.number);
      assert.strictEqual(item.titleLt, ch.titleLt);
      assert.strictEqual(item.titleRu, ch.titleRu);
      assert.strictEqual(item.access, ch.access);
      assert.strictEqual(item.articleCount, ch.articles.length);
      assert.strictEqual(item.questionCount, qCountByChapter.get(ch.id) || 0);
      assert.strictEqual(item.firstArticle, ch.articles[0].number);
      assert.strictEqual(item.lastArticle, ch.articles[ch.articles.length - 1].number);
    }
  });
});

describe('Constitution bundle protection and import graph', () => {
  it('client code never imports constitution index.ts, paid chapters, or paid questions', () => {
    const root = fileURLToPath(new URL('../../../..', import.meta.url));
    const allowedIndexImporters = new Set([
      'src/data/lt/constitution/constitution.test.ts',
      'src/data/lt/constitution/constitutionProtection.test.ts',
      'src/data/lt/constitution/constitutionAccess.ts',
      'src/data/lt/constitution/constitutionAccess.test.ts',
      'api/_constitution.test.ts',
      'src/data/lt/constitution/constitutionDistLeak.test.ts',
      'src/data/lt/constitution/mockExams.test.ts',
    ]);

    const allowedPaidImporters = new Set([
      'src/data/lt/constitution/index.ts',
      'src/data/lt/constitution/constitutionAccess.ts',
      'src/data/lt/constitution/constitutionAccess.test.ts',
      'src/data/lt/constitution/constitutionProtection.test.ts',
    ]);

    // Состав вариантов пробного экзамена: только серверный бандл (и тесты).
    const allowedMockVariantImporters = new Set([
      'src/data/lt/constitution/constitutionAccess.ts',
      'src/data/lt/constitution/constitutionDistLeak.test.ts',
      'src/data/lt/constitution/mockExams.test.ts',
      'src/data/lt/constitution/constitutionProtection.test.ts',
      'src/data/lt/constitution/mockExamVariants.ts',
    ]);

    const forbiddenChapterRegex = /chapters\/ch(0[3-9]|1[0-5])/;
    const forbiddenQuestionRegex = /questions\/ch(0[3-9]|1[0-5])/;

    const leaks: string[] = [];

    for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'api'))]) {
      const rel = relative(root, file).replace(/\\/g, '/');
      // Skip the source files of the chapters/questions themselves
      if (rel.startsWith('src/data/lt/constitution/chapters/') && forbiddenChapterRegex.test(rel)) {
        continue;
      }
      if (rel.startsWith('src/data/lt/constitution/questions/') && forbiddenQuestionRegex.test(rel)) {
        continue;
      }

      const text = readFileSync(file, 'utf8');
      const specifiers = extractImportSpecifiers(text);

      for (const spec of specifiers) {
        const target = resolveTarget(file, root, spec);
        if (!target) continue;

        // Check resolved target against constitution/index
        if (target === 'src/data/lt/constitution' || target === 'src/data/lt/constitution/index') {
          if (!allowedIndexImporters.has(rel)) {
            leaks.push(`${rel} illegally imports constitution/index.ts via "${spec}"`);
          }
        }

        if (target === 'src/data/lt/constitution/mockExamVariants' && !allowedMockVariantImporters.has(rel)) {
          leaks.push(`${rel} illegally imports mockExamVariants via "${spec}"`);
        }

        // Check resolved target against paid chapters (ch03..ch15)
        if (/^src\/data\/lt\/constitution\/chapters\/ch(0[3-9]|1[0-5])$/.test(target)) {
          if (!allowedPaidImporters.has(rel)) {
            leaks.push(`${rel} illegally imports paid chapter via "${spec}"`);
          }
        }

        // Check resolved target against paid questions (ch03..ch15)
        if (/^src\/data\/lt\/constitution\/questions\/ch(0[3-9]|1[0-5])$/.test(target)) {
          if (!allowedPaidImporters.has(rel)) {
            leaks.push(`${rel} illegally imports paid question bank via "${spec}"`);
          }
        }
      }

      if (/mockExamVariants|MOCK_EXAM_VARIANT_DEFINITIONS/.test(text) && !allowedMockVariantImporters.has(rel)) {
        leaks.push(`${rel} illegally references mockExamVariants in text`);
      }

      // Fallback text check for any string literals containing forbidden paths
      if (forbiddenChapterRegex.test(text) && !allowedPaidImporters.has(rel)) {
        leaks.push(`${rel} illegally references paid chapter ch03..ch15 in text`);
      }
      if (forbiddenQuestionRegex.test(text) && !allowedPaidImporters.has(rel)) {
        leaks.push(`${rel} illegally references paid question bank ch03..ch15 in text`);
      }
    }

    assert.deepStrictEqual(leaks, []);
  });
});
