import { interviewCardId } from '../../../exam/interviewCardId';
import { INTERVIEW_QUESTIONS, type InterviewQuestion } from './interviewQuestions';

/**
 * Free tier is a prefix of the bank: the first 12 questions, in file order
 * (topics stay in that order, so a topic may be split). Templates are paid
 * for every question, including the free prefix.
 */
export const FREE_INTERVIEW_COUNT = 12;

export type InterviewTopicSummary = {
  id: string;
  total: number;
  available: number;
  locked: boolean;
};

/** Question sent to the client. `templates` is present only for a paid caller. */
export type ClientInterviewQuestion = {
  id: string;
  topic: string;
  lt: string;
  ru: string;
  en: string;
  templates?: string[];
};

export type InterviewPayload = {
  paid: boolean;
  total: number;
  freeCount: number;
  topics: InterviewTopicSummary[];
  questions: ClientInterviewQuestion[];
};

function withoutTemplates(q: InterviewQuestion): ClientInterviewQuestion {
  return { id: q.id, topic: q.topic, lt: q.lt, ru: q.ru, en: q.en };
}

/** Payload for the trainer. Unpaid callers never receive later questions or any template. */
export function interviewPayload(paid: boolean): InterviewPayload {
  const topicOrder: string[] = [];
  const totals = new Map<string, { total: number; available: number }>();
  const questions: ClientInterviewQuestion[] = [];

  INTERVIEW_QUESTIONS.forEach((q, index) => {
    if (!totals.has(q.topic)) {
      topicOrder.push(q.topic);
      totals.set(q.topic, { total: 0, available: 0 });
    }
    const bucket = totals.get(q.topic)!;
    bucket.total += 1;
    if (!paid && index >= FREE_INTERVIEW_COUNT) return;
    bucket.available += 1;
    questions.push(paid ? { ...withoutTemplates(q), templates: [...q.templates] } : withoutTemplates(q));
  });

  return {
    paid,
    total: INTERVIEW_QUESTIONS.length,
    freeCount: FREE_INTERVIEW_COUNT,
    topics: topicOrder.map(id => {
      const row = totals.get(id)!;
      return { id, total: row.total, available: row.available, locked: row.available === 0 };
    }),
    questions,
  };
}

/** LT question → meaning. One card per question in the bank, in bank order. */
export function interviewCardTerms(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of INTERVIEW_QUESTIONS) out[interviewCardId(q.id)] = q.lt;
  return out;
}
