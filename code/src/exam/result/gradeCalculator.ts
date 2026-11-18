import { scoreBlock, scorePart, scoreSpeaking, verdict } from '../core/scoring';
import type {
  BlockScore,
  BlockSpec,
  ExamSpec,
  Item,
  ItemScore,
  PartId,
  PartScore,
  SpeakingLevel,
} from '../core/types';
import { RESULT_STRINGS, type ResultLang } from './strings';

export const EXAM_RESULT_RANGES = {
  rwA1: { min: 0, max: 22 },
  rwA2: { min: 0, max: 28 },
  listenA1: { min: 0, max: 10 },
  listenA2: { min: 0, max: 10 },
  speakSituation: { min: 0, max: 3 },
  speakInterviewer: { min: 0, max: 1 },
} as const;

export const CAT1_CALCULATOR_SPEC: ExamSpec = {
  specVersion: 1,
  id: 'a2-cat1',
  parts: [
    { id: 'rw', maxPoints: 50, scored: true },
    { id: 'listen', maxPoints: 20, scored: true },
    { id: 'speak', maxPoints: 10, scored: true },
  ],
  blocks: [
    { id: 'rw-a1', part: 'rw', level: 'A1', tasks: [1, 2, 3, 4], maxPoints: 22, passPoints: 13 },
    { id: 'rw-a2', part: 'rw', level: 'A2', tasks: [5, 6, 7, 8, 9], maxPoints: 28, passPoints: 17, requires: 'rw-a1' },
    { id: 'listen-a1', part: 'listen', level: 'A1', tasks: [1, 2], maxPoints: 10, passPoints: 6 },
    { id: 'listen-a2', part: 'listen', level: 'A2', tasks: [3, 4], maxPoints: 10, passPoints: 6, requires: 'listen-a1' },
  ],
};

export interface ExamCalculatorInput {
  rwA1: number;
  rwA2: number;
  listenA1: number;
  listenA2: number;
  speakSituations: readonly [number, number, number];
  speakInterviewer: number;
}

export type CalculatorPartLevel = 'A2' | 'A1' | 'none';

export interface CalculatorPartEvaluation {
  partId: PartId;
  level: CalculatorPartLevel;
  earned: number;
  max: number;
  reason: string;
}

export interface ExamCalculatorResult {
  input: ExamCalculatorInput;
  finalLevel: CalculatorPartLevel;
  finalSummary: string;
  parts: Record<PartId, CalculatorPartEvaluation>;
}

export function emptyCalculatorInput(): ExamCalculatorInput {
  return {
    rwA1: 0,
    rwA2: 0,
    listenA1: 0,
    listenA2: 0,
    speakSituations: [0, 0, 0],
    speakInterviewer: 0,
  };
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const whole = Math.trunc(value);
  return Math.min(max, Math.max(min, whole));
}

export function parseClampedNumericInput(raw: string, max: number): { draft: string; value: number } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { draft: '', value: 0 };
  }
  if (/^-?\d+([.,]\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed.replace(',', '.'));
    const clamped = clampInt(parsed, 0, max);
    return { draft: String(clamped), value: clamped };
  }
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits === '') {
    return { draft: '', value: 0 };
  }
  const clamped = clampInt(Number(digits), 0, max);
  return { draft: String(clamped), value: clamped };
}

export function clampCalculatorInput(input: ExamCalculatorInput): ExamCalculatorInput {
  return {
    rwA1: clampInt(input.rwA1, EXAM_RESULT_RANGES.rwA1.min, EXAM_RESULT_RANGES.rwA1.max),
    rwA2: clampInt(input.rwA2, EXAM_RESULT_RANGES.rwA2.min, EXAM_RESULT_RANGES.rwA2.max),
    listenA1: clampInt(input.listenA1, EXAM_RESULT_RANGES.listenA1.min, EXAM_RESULT_RANGES.listenA1.max),
    listenA2: clampInt(input.listenA2, EXAM_RESULT_RANGES.listenA2.min, EXAM_RESULT_RANGES.listenA2.max),
    speakSituations: [
      clampInt(input.speakSituations[0], EXAM_RESULT_RANGES.speakSituation.min, EXAM_RESULT_RANGES.speakSituation.max),
      clampInt(input.speakSituations[1], EXAM_RESULT_RANGES.speakSituation.min, EXAM_RESULT_RANGES.speakSituation.max),
      clampInt(input.speakSituations[2], EXAM_RESULT_RANGES.speakSituation.min, EXAM_RESULT_RANGES.speakSituation.max),
    ],
    speakInterviewer: clampInt(
      input.speakInterviewer,
      EXAM_RESULT_RANGES.speakInterviewer.min,
      EXAM_RESULT_RANGES.speakInterviewer.max,
    ),
  };
}

function getBlockSpec(blockId: string): BlockSpec {
  const found = CAT1_CALCULATOR_SPEC.blocks.find((b) => b.id === blockId);
  if (!found) {
    throw new Error(`Missing block spec '${blockId}'.`);
  }
  return found;
}

function scoreManualBlock(blockId: string, earnedPoints: number): { spec: BlockSpec; score: BlockScore } {
  const spec = getBlockSpec(blockId);
  const item: Item = {
    id: `${spec.id}-manual`,
    blockId: spec.id,
    kind: 'mcq',
    points: spec.maxPoints,
    scoring: 'auto',
    prompt: spec.id,
  };
  const itemScore: ItemScore = {
    itemId: item.id,
    earned: earnedPoints,
    max: spec.maxPoints,
    status: earnedPoints >= spec.maxPoints ? 'correct' : earnedPoints <= 0 ? 'wrong' : 'partial',
  };
  return {
    spec,
    score: scoreBlock(spec, [item], [itemScore]),
  };
}

function formatTwoBlockReason(
  a1Spec: BlockSpec,
  a1Score: BlockScore,
  a2Spec: BlockSpec,
  a2Score: BlockScore,
  level: CalculatorPartLevel,
  lang: ResultLang,
): string {
  const s = RESULT_STRINGS[lang].reasons;
  if (level === 'A2') {
    return s.blockPassedBoth(a1Score.earned, a1Spec.maxPoints, a2Score.earned, a2Spec.maxPoints);
  }
  if (level === 'A1') {
    return s.a2FailedAfterA1(
      a2Score.earned,
      a2Spec.maxPoints,
      a2Spec.passPoints,
      a1Score.earned,
      a1Spec.maxPoints,
    );
  }
  if (a2Score.passed === 'yes') {
    return s.a1FailedWithA2Passed(
      a1Score.earned,
      a1Spec.maxPoints,
      a1Spec.passPoints,
      a2Score.earned,
      a2Spec.maxPoints,
    );
  }
  return s.a1Failed(a1Score.earned, a1Spec.maxPoints, a1Spec.passPoints);
}

function formatSpeakingReason(
  situations: readonly [number, number, number],
  interviewer: number,
  level: SpeakingLevel,
  lang: ResultLang,
): string {
  const s = RESULT_STRINGS[lang].reasons;
  const sorted = [...situations].sort((a, b) => b - a);
  const bestTwo = sorted[0] + sorted[1];
  const total = interviewer + situations[0] + situations[1] + situations[2];
  const ge2Count = situations.filter((v) => v >= 2).length;

  if (level === 'A2') {
    return s.speakA2(total, bestTwo);
  }
  if (level === 'A1') {
    if (total < 6 && bestTwo < 5) {
      return s.speakA1BothMissing(total, bestTwo);
    }
    if (total < 6) {
      return s.speakA1LowTotal(total, bestTwo);
    }
    return s.speakA1LowBestTwo(total, bestTwo);
  }
  if (total < 5 && ge2Count < 2) {
    return s.speakNoneBoth(total, ge2Count);
  }
  if (total < 5) {
    return s.speakNoneLowTotal(total);
  }
  return s.speakNoneFewSituations(total, ge2Count);
}

function toCalculatorPartLevel(level: PartScore['level']): CalculatorPartLevel {
  return level === 'A2' || level === 'A1' ? level : 'none';
}

export function evaluateExamResult(rawInput: ExamCalculatorInput, lang: ResultLang): ExamCalculatorResult {
  const input = clampCalculatorInput(rawInput);
  const strings = RESULT_STRINGS[lang];

  const rwA1 = scoreManualBlock('rw-a1', input.rwA1);
  const rwA2 = scoreManualBlock('rw-a2', input.rwA2);
  const rwPart = scorePart(CAT1_CALCULATOR_SPEC, [rwA1.score, rwA2.score], 'rw');

  const listenA1 = scoreManualBlock('listen-a1', input.listenA1);
  const listenA2 = scoreManualBlock('listen-a2', input.listenA2);
  const listenPart = scorePart(CAT1_CALCULATOR_SPEC, [listenA1.score, listenA2.score], 'listen');

  const speakLevel = scoreSpeaking({
    situations: input.speakSituations,
    interlocutor: input.speakInterviewer,
  });
  const speakEarned =
    input.speakInterviewer +
    input.speakSituations[0] +
    input.speakSituations[1] +
    input.speakSituations[2];
  const speakPart: PartScore = {
    partId: 'speak',
    level: speakLevel,
    earned: speakEarned,
    unscoredMax: 0,
    max: 10,
    blocks: [],
  };

  const finalVerdict = verdict(CAT1_CALCULATOR_SPEC, [rwPart, listenPart, speakPart]);
  const finalLevel: CalculatorPartLevel =
    finalVerdict.level === 'A2' || finalVerdict.level === 'A1' ? finalVerdict.level : 'none';

  const rwEval: CalculatorPartEvaluation = {
    partId: 'rw',
    level: toCalculatorPartLevel(rwPart.level),
    earned: rwPart.earned,
    max: rwPart.max,
    reason: formatTwoBlockReason(
      rwA1.spec,
      rwA1.score,
      rwA2.spec,
      rwA2.score,
      toCalculatorPartLevel(rwPart.level),
      lang,
    ),
  };

  const listenEval: CalculatorPartEvaluation = {
    partId: 'listen',
    level: toCalculatorPartLevel(listenPart.level),
    earned: listenPart.earned,
    max: listenPart.max,
    reason: formatTwoBlockReason(
      listenA1.spec,
      listenA1.score,
      listenA2.spec,
      listenA2.score,
      toCalculatorPartLevel(listenPart.level),
      lang,
    ),
  };

  const speakEval: CalculatorPartEvaluation = {
    partId: 'speak',
    level: speakLevel,
    earned: speakEarned,
    max: 10,
    reason: formatSpeakingReason(input.speakSituations, input.speakInterviewer, speakLevel, lang),
  };

  const orderedParts: CalculatorPartEvaluation[] = [rwEval, listenEval, speakEval];
  let finalSummary: string;
  if (finalLevel === 'A2') {
    finalSummary = strings.finalA2Summary;
  } else if (finalLevel === 'none') {
    const failedNames = orderedParts
      .filter((p) => p.level === 'none')
      .map((p) => strings.partNamesInline[p.partId])
      .join(', ');
    finalSummary = strings.finalNoneSummary(failedNames);
  } else {
    const a1Parts = orderedParts.filter((p) => p.level === 'A1');
    const a1Names = a1Parts.map((p) => strings.partNamesInline[p.partId]).join(', ');
    finalSummary = strings.finalA1Summary(a1Names, a1Parts.length);
  }

  return {
    input,
    finalLevel,
    finalSummary,
    parts: {
      rw: rwEval,
      listen: listenEval,
      speak: speakEval,
    },
  };
}
