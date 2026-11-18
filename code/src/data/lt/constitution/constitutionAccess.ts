// Серверная точка входа: единственное место, откуда платные главы (ch3..ch15) попадают в код.
// Её бандлит esbuild в api/exam/_constitutionAccess.cjs (scripts/bundle-interview-access.mjs),
// а api/exam/_constitution.js отдаёт главу только после проверки доступа.
// Клиентский код (src/**, кроме тестов) эту точку и index.ts не импортирует — это проверяют
// constitutionProtection.test.ts (граф импортов) и constitutionDistLeak.test.ts (сборка dist/).
import { constitutionChapters, constitutionQuestions } from './index';
import { constitutionMetadata } from './meta';
import type { ConstitutionChapter, ConstitutionQuestion } from './types';
import { MOCK_EXAM_VARIANT_DEFINITIONS } from './mockExamVariants';

export const CONSTITUTION_CHAPTER_COUNT = 15;
/** Главы 1–2 бесплатны и лежат в клиентской сборке; 3–15 только на сервере. */
export const FREE_CONSTITUTION_CHAPTERS = 2;

export interface ConstitutionChapterPayload {
  chapter: ConstitutionChapter;
  questions: ConstitutionQuestion[];
  translationNoticeRu: string;
  translationNoticeLt: string;
  isUnofficialTranslation: true;
}

export function isFreeConstitutionChapter(n: number): boolean {
  return n >= 1 && n <= FREE_CONSTITUTION_CHAPTERS;
}

/** Глава n (1..15) с вопросами или null, если номер вне диапазона. */
export function constitutionChapterPayload(n: number): ConstitutionChapterPayload | null {
  if (!Number.isInteger(n) || n < 1 || n > CONSTITUTION_CHAPTER_COUNT) return null;
  const chapter = constitutionChapters.find(c => c.number === n);
  if (!chapter) return null;
  return {
    chapter,
    questions: constitutionQuestions.filter(q => q.chapterId === chapter.id),
    translationNoticeRu: constitutionMetadata.translationNoticeRu,
    translationNoticeLt: constitutionMetadata.translationNoticeLt,
    isUnofficialTranslation: true,
  };
}

export interface ConstitutionMockPayload {
  variantId: string;
  questions: ConstitutionQuestion[];
}

/** Вопросы варианта пробного экзамена в фиксированном порядке или null для неизвестного варианта. */
export function constitutionMockPayload(variantId: string): ConstitutionMockPayload | null {
  const variant = MOCK_EXAM_VARIANT_DEFINITIONS.find(v => v.id === variantId);
  if (!variant) return null;
  const byId = new Map(constitutionQuestions.map(q => [q.id, q]));
  const questions: ConstitutionQuestion[] = [];
  for (const id of variant.questionIds) {
    const q = byId.get(id);
    if (!q) return null;
    questions.push(q);
  }
  return { variantId: variant.id, questions };
}
