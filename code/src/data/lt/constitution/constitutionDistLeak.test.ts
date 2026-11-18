// Утечка платного текста в клиент: собираем клиентскую сборку Vite во временную папку
// и ищем в каждом файле характерные фразы глав 3–15 (тело статей LT/RU, вопросы, пояснения).
// Заголовки глав не проверяем: они намеренно в клиенте (outline.ts).
// Контрольный поиск: фраза бесплатной главы 1 в сборке ДОЛЖНА найтись, иначе поиск ничего не доказывает.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { constitutionChapters, constitutionQuestions } from './index';
import { MOCK_EXAM_VARIANT_DEFINITIONS } from './mockExamVariants';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

/** Самый длинный кусок строки без кавычек, слэшей и переводов строк: переживёт любую (де)экранизацию в бандле. */
export function distinctiveSlice(text: string, min = 28): string | null {
  const parts = text.split(/["'\\\n`«»„“”‘’]/).map(p => p.trim());
  const best = parts.sort((a, b) => b.length - a.length)[0] ?? '';
  return best.length >= min ? best.slice(0, 60) : null;
}

function readAll(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readAll(full, acc);
    else acc.push(full);
  }
  return acc;
}

describe('client dist leak check (chapters 3–15)', () => {
  let outDir = '';
  let corpus: Array<{ file: string; text: string }> = [];

  before(() => {
    outDir = mkdtempSync(join(tmpdir(), 'mlt-leak-'));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../../../node_modules/vite/bin/vite.js', import.meta.url)), 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, VITE_EXAM_UI: 'true' } },
    );
    assert.equal(result.status, 0, `vite build failed:\n${result.stdout}\n${result.stderr}`);
    corpus = readAll(outDir)
      .filter(f => /\.(js|mjs|css|html|json|webmanifest|txt|map)$/.test(f))
      .map(file => ({ file, text: readFileSync(file, 'utf8') }));
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const findIn = (needle: string) => corpus.filter(f => f.text.includes(needle)).map(f => f.file.replace(outDir, 'dist'));

  it('контроль: текст бесплатной главы 1 в сборке есть (поиск работает)', () => {
    const phrase = distinctiveSlice(constitutionChapters[0].articles[0].paragraphs[0].lt, 20);
    assert.ok(phrase, 'no control phrase');
    assert.ok(corpus.length > 0);
    assert.ok(findIn(phrase).length > 0, `control phrase not found in dist: ${phrase}`);
  });

  it('тело статей (LT и RU) и вопросы глав 3–15 отсутствуют в dist', () => {
    const needles: Array<{ label: string; text: string }> = [];
    for (const chapter of constitutionChapters.filter(c => c.number >= 3)) {
      const paragraphs = chapter.articles.flatMap(a => a.paragraphs);
      // Несколько абзацев из каждой главы: первый, средний, последний.
      for (const p of [paragraphs[0], paragraphs[Math.floor(paragraphs.length / 2)], paragraphs[paragraphs.length - 1]]) {
        for (const [lang, value] of [['lt', p.lt], ['ru', p.ru]] as const) {
          const slice = distinctiveSlice(value);
          if (slice) needles.push({ label: `ch${chapter.number} ${lang}`, text: slice });
        }
      }
      const q = constitutionQuestions.find(x => x.chapterId === chapter.id);
      if (q) {
        for (const [label, value] of [['qLt', q.qLt], ['qRu', q.qRu], ['explanationRu', q.explanationRu]] as const) {
          const slice = distinctiveSlice(value, 20);
          if (slice) needles.push({ label: `ch${chapter.number} ${label}`, text: slice });
        }
      }
    }
    const checkedChapters = new Set(needles.map(n => n.label.split(' ')[0]));
    assert.equal(checkedChapters.size, 13, 'каждая из глав 3–15 должна иметь проверяемую фразу');
    assert.ok(needles.length >= 39, `слишком мало фраз: ${needles.length}`);

    const leaks = needles.flatMap(n => findIn(n.text).map(file => `${n.label}: «${n.text}» in ${file}`));
    assert.deepEqual(leaks, []);
  });

  it('пробные экзамены: ни состава вариантов, ни текста вопросов (глав 3–15) в dist нет', () => {
    const paidMock = MOCK_EXAM_VARIANT_DEFINITIONS.flatMap(v => v.questionIds)
      .map(id => constitutionQuestions.find(q => q.id === id)!)
      .filter(q => !['ch1', 'ch2'].includes(q.chapterId));
    assert.ok(paidMock.length >= 50, `вопросов пробных экзаменов из платных глав: ${paidMock.length}`);
    // Фраза, которая цитирует бесплатную главу (напр. ст. 1 в вопросе гл. 14), законно есть в клиенте.
    const freeText = JSON.stringify([
      constitutionChapters.filter(c => c.number <= 2),
      constitutionQuestions.filter(q => ['ch1', 'ch2'].includes(q.chapterId)),
    ]);
    const leaks: string[] = [];
    for (const q of paidMock) {
      for (const [label, value] of [['qLt', q.qLt], ['qRu', q.qRu], ['explanationRu', q.explanationRu]] as const) {
        const slice = distinctiveSlice(value, 20);
        if (slice && !freeText.includes(slice)) leaks.push(...findIn(slice).map(file => `${q.id} ${label} in ${file}`));
      }
    }
    assert.deepEqual(leaks, []);
    // Состав вариантов (id вопросов в нужном порядке) тоже серверный: ни одной строки с id варианта.
    assert.deepEqual(findIn('MOCK_EXAM_VARIANT_DEFINITIONS'), []);
    assert.deepEqual(findIn('const-q-ch5-10'), []);
    assert.deepEqual(findIn('constitutionMockPayload'), []);
  });

  it('в dist нет серверного бандла constitutionAccess и импорта платных глав', () => {
    assert.deepEqual(findIn('constitutionChapterPayload'), []);
    assert.deepEqual(findIn('_constitutionAccess'), []);
  });
});
