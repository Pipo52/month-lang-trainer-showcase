import type {
  AnswerKey,
  AnswerKeyMap,
  AnswerMap,
  AttemptResult,
  BlockScore,
  BlockSpec,
  ExamSpec,
  Item,
  ItemAnswer,
  ItemScore,
  Mock,
  PartId,
  PartLevel,
  PartScore,
  PartSpec,
  PassStatus,
  SpeakingLevel,
  SpeakingScoreInput,
  Verdict,
} from './types';

function roundPoints(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Normalises a string for comparison: NFC-normalised, trimmed, case-insensitive,
 * while preserving Lithuanian letters (ą, č, ę, ė, į, š, ų, ū, ž).
 */
export function normaliseAnswerString(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string | readonly string[]>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneAnswerValue(value: ItemAnswer): ItemAnswer {
  if (value === undefined || value === null || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  if (isStringRecord(value)) {
    return { ...(value as Readonly<Record<string, string>>) };
  }
  return value;
}

/**
 * Scores a single exam item purely without mutating inputs.
 *
 * Rules:
 * - `self` scoring or `writing` kind -> `earned: 0`, `status: 'self'` (counted in `unscoredMax`).
 * - Blank / undefined / empty answers -> `earned: 0`, `status: 'blank'`.
 * - `mcq`: exact match (trimmed, case-insensitive, Lithuanian letters preserved) earns full points.
 * - `multi`: partial credit equals `(max(0, correctSelections - wrongSelections) / totalCorrectInKey) * item.points`.
 *   Duplicate selections in the learner answer are deduplicated after normalisation.
 * - `match` / `gap`: per-sub-answer proportional credit `(correctSubAnswers / totalSubKeys) * item.points`.
 *   Extra keys in the learner's answer object that do not exist in the answer key are ignored.
 */
export function scoreItem(
  item: Item,
  key: AnswerKey | undefined,
  answer: ItemAnswer,
): ItemScore {
  const max = item.points;

  if (item.scoring === 'self' || item.kind === 'writing') {
    return { itemId: item.id, earned: 0, max, status: 'self' };
  }

  if (item.kind === 'mcq') {
    if (typeof answer !== 'string' || answer.trim() === '') {
      return { itemId: item.id, earned: 0, max, status: 'blank' };
    }
    const normAns = normaliseAnswerString(answer);
    const accepted =
      typeof key === 'string'
        ? [normaliseAnswerString(key)]
        : Array.isArray(key)
          ? key.map((k) => normaliseAnswerString(String(k)))
          : [];
    const isCorrect = accepted.includes(normAns);
    return {
      itemId: item.id,
      earned: isCorrect ? max : 0,
      max,
      status: isCorrect ? 'correct' : 'wrong',
    };
  }

  if (item.kind === 'multi') {
    if (!Array.isArray(answer)) {
      return { itemId: item.id, earned: 0, max, status: 'blank' };
    }
    const selectedSet = new Set<string>();
    for (const raw of answer) {
      if (typeof raw === 'string' && raw.trim() !== '') {
        selectedSet.add(normaliseAnswerString(raw));
      }
    }
    if (selectedSet.size === 0) {
      return { itemId: item.id, earned: 0, max, status: 'blank' };
    }

    const keyList = Array.isArray(key)
      ? key
      : typeof key === 'string'
        ? [key]
        : [];
    const correctSet = new Set<string>();
    for (const k of keyList) {
      if (typeof k === 'string' && k.trim() !== '') {
        correctSet.add(normaliseAnswerString(k));
      }
    }

    if (correctSet.size === 0) {
      return { itemId: item.id, earned: 0, max, status: 'wrong' };
    }

    let correctSelections = 0;
    let wrongSelections = 0;
    for (const sel of selectedSet) {
      if (correctSet.has(sel)) {
        correctSelections += 1;
      } else {
        wrongSelections += 1;
      }
    }

    const netCorrect = Math.max(0, correctSelections - wrongSelections);
    const earned = roundPoints((netCorrect / correctSet.size) * max);

    if (netCorrect === correctSet.size && wrongSelections === 0) {
      return { itemId: item.id, earned: max, max, status: 'correct' };
    }
    if (earned <= 0) {
      return { itemId: item.id, earned: 0, max, status: 'wrong' };
    }
    return { itemId: item.id, earned, max, status: 'partial' };
  }

  // 'match' or 'gap'
  if (typeof key === 'string' || Array.isArray(key)) {
    if (typeof answer !== 'string' || answer.trim() === '') {
      return { itemId: item.id, earned: 0, max, status: 'blank' };
    }
    const normAns = normaliseAnswerString(answer);
    const accepted =
      typeof key === 'string'
        ? [normaliseAnswerString(key)]
        : key.map((k) => normaliseAnswerString(String(k)));
    const isCorrect = accepted.includes(normAns);
    return {
      itemId: item.id,
      earned: isCorrect ? max : 0,
      max,
      status: isCorrect ? 'correct' : 'wrong',
    };
  }

  if (!isStringRecord(key)) {
    if (
      answer === undefined ||
      answer === null ||
      (typeof answer === 'string' && answer.trim() === '') ||
      (isStringRecord(answer) &&
        Object.values(answer).every((v) => typeof v !== 'string' || v.trim() === ''))
    ) {
      return { itemId: item.id, earned: 0, max, status: 'blank' };
    }
    return { itemId: item.id, earned: 0, max, status: 'wrong' };
  }

  const subKeys = Object.keys(key);
  if (subKeys.length === 0) {
    return { itemId: item.id, earned: 0, max, status: 'blank' };
  }

  if (!isStringRecord(answer)) {
    return { itemId: item.id, earned: 0, max, status: 'blank' };
  }

  const answerRecord = answer as Readonly<Record<string, string>>;
  let nonBlankCount = 0;
  let correctCount = 0;

  for (const subKey of subKeys) {
    const rawAns = answerRecord[subKey];
    if (typeof rawAns !== 'string' || rawAns.trim() === '') {
      continue;
    }
    nonBlankCount += 1;
    const normAns = normaliseAnswerString(rawAns);
    const expected = key[subKey];
    if (typeof expected === 'string') {
      if (normaliseAnswerString(expected) === normAns) {
        correctCount += 1;
      }
    } else if (Array.isArray(expected)) {
      if (expected.some((opt) => normaliseAnswerString(String(opt)) === normAns)) {
        correctCount += 1;
      }
    }
  }

  if (nonBlankCount === 0) {
    return { itemId: item.id, earned: 0, max, status: 'blank' };
  }

  const earned = roundPoints((correctCount / subKeys.length) * max);
  if (correctCount === subKeys.length) {
    return { itemId: item.id, earned: max, max, status: 'correct' };
  }
  if (earned <= 0) {
    return { itemId: item.id, earned: 0, max, status: 'wrong' };
  }
  return { itemId: item.id, earned, max, status: 'partial' };
}

/**
 * Scores a single block from its specification, items, and item scores.
 * `passed` is:
 * - `'yes'` if `earned >= passPoints`
 * - `'no'` if `earned + unscoredMax < passPoints`
 * - `'unknown'` otherwise
 */
export function scoreBlock(
  spec: BlockSpec,
  blockItems: readonly Item[],
  scores: readonly ItemScore[] | Readonly<Record<string, ItemScore>>,
): BlockScore {
  const scoreMap = new Map<string, ItemScore>();
  if (Array.isArray(scores)) {
    for (const s of scores) {
      scoreMap.set(s.itemId, s);
    }
  } else {
    for (const [id, s] of Object.entries(scores as Readonly<Record<string, ItemScore>>)) {
      scoreMap.set(id, s);
    }
  }

  const itemsForBlock = blockItems.filter((item) => item.blockId === spec.id);
  let earned = 0;
  let unscoredMax = 0;

  for (const item of itemsForBlock) {
    const s = scoreMap.get(item.id);
    if (item.scoring === 'self' || item.kind === 'writing' || s?.status === 'self') {
      unscoredMax += item.points;
    } else if (s) {
      earned += s.earned;
    }
  }

  earned = roundPoints(earned);
  unscoredMax = roundPoints(unscoredMax);

  let passed: PassStatus;
  if (earned >= spec.passPoints) {
    passed = 'yes';
  } else if (roundPoints(earned + unscoredMax) < spec.passPoints) {
    passed = 'no';
  } else {
    passed = 'unknown';
  }

  return {
    blockId: spec.id,
    earned,
    unscoredMax,
    max: spec.maxPoints,
    passed,
  };
}

/**
 * Scores an exam part from its specification and block scores, honouring `requires` dependencies.
 *
 * Part level rules:
 * - `'A2'` if the A2 block passed AND its required A1 block passed.
 * - `'A1'` if the A1 block passed and the A2 block failed (`'no'`).
 * - `'none'` if the A1 block failed (`'no'`).
 * - `'unknown'` if the part is unscored (e.g. speaking in v0) or if self-scored items leave the outcome undecided.
 */
export function scorePart(
  spec: ExamSpec,
  blockScores: readonly BlockScore[] | Readonly<Record<string, BlockScore>>,
  partId?: PartId,
): PartScore {
  const scoreMap = new Map<string, BlockScore>();
  const scoreList: BlockScore[] = [];
  if (Array.isArray(blockScores)) {
    for (const bs of blockScores) {
      scoreMap.set(bs.blockId, bs);
      scoreList.push(bs);
    }
  } else {
    for (const bs of Object.values(blockScores as Readonly<Record<string, BlockScore>>)) {
      scoreMap.set(bs.blockId, bs);
      scoreList.push(bs);
    }
  }

  let resolvedPartId: PartId = partId ?? 'rw';
  const allBlocks: readonly BlockSpec[] = spec.blocks;

  if (!partId && scoreList.length > 0) {
    const matched = allBlocks.find((b) => b.id === scoreList[0].blockId);
    if (matched) {
      resolvedPartId = matched.part;
    }
  }

  const partSpec: PartSpec | undefined = spec.parts.find((p) => p.id === resolvedPartId);
  const partBlocks = allBlocks.filter((b) => b.part === resolvedPartId);
  const matchingScores = partBlocks
    .map((b) => scoreMap.get(b.id))
    .filter((bs): bs is BlockScore => bs !== undefined);

  // Unscored part (such as speaking in v0) when no block scores are supplied
  if (
    (partSpec?.scored === false && matchingScores.length === 0) ||
    (partBlocks.length === 0 && matchingScores.length === 0)
  ) {
    const maxPts = partSpec?.maxPoints ?? 0;
    return {
      partId: resolvedPartId,
      level: 'unknown',
      earned: 0,
      unscoredMax: maxPts,
      max: maxPts,
      blocks: [],
    };
  }

  const blockSpecById = new Map<string, BlockSpec>();
  for (const b of allBlocks) {
    blockSpecById.set(b.id, b);
  }

  const evaluateEffectivePass = (
    blockSpec: BlockSpec,
    visited = new Set<string>(),
  ): PassStatus => {
    if (visited.has(blockSpec.id)) {
      return 'no';
    }
    visited.add(blockSpec.id);

    const bs = scoreMap.get(blockSpec.id);
    const ownPassed: PassStatus = bs ? bs.passed : 'unknown';

    if (!blockSpec.requires) {
      return ownPassed;
    }

    const reqSpec = blockSpecById.get(blockSpec.requires);
    const reqPassed: PassStatus = reqSpec
      ? evaluateEffectivePass(reqSpec, visited)
      : (scoreMap.get(blockSpec.requires)?.passed ?? 'no');

    if (reqPassed === 'no' || ownPassed === 'no') {
      return 'no';
    }
    if (reqPassed === 'yes' && ownPassed === 'yes') {
      return 'yes';
    }
    return 'unknown';
  };

  const a1Spec = partBlocks.find((b) => b.level === 'A1');
  const a2Spec = partBlocks.find((b) => b.level === 'A2');

  const a1Passed: PassStatus = a1Spec ? evaluateEffectivePass(a1Spec) : 'unknown';
  const a2Passed: PassStatus = a2Spec ? evaluateEffectivePass(a2Spec) : 'no';

  let level: PartLevel;
  if (a1Passed === 'no') {
    level = 'none';
  } else if (a1Passed === 'yes') {
    if (a2Passed === 'yes') {
      level = 'A2';
    } else if (a2Passed === 'no') {
      level = 'A1';
    } else {
      level = 'unknown';
    }
  } else {
    level = 'unknown';
  }

  const earned = roundPoints(matchingScores.reduce((sum, b) => sum + b.earned, 0));
  const unscoredMax = roundPoints(
    matchingScores.reduce((sum, b) => sum + b.unscoredMax, 0),
  );
  const max =
    partSpec?.maxPoints ??
    roundPoints(partBlocks.reduce((sum, b) => sum + b.maxPoints, 0));

  return {
    partId: resolvedPartId,
    level,
    earned,
    unscoredMax,
    max,
    blocks: matchingScores.map((b) => ({ ...b })),
  };
}

function clampSpeakingScore(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(max, Math.max(0, value));
}

/**
 * Pure NŠA speaking scorer (Category I, A1–A2):
 * - 3 situations scored 0–3 each + interlocutor 0–1 for the whole part (max 10).
 * - A2: total >= 6 AND sum of best two situations >= 5 (and at least two situations >= 2).
 * - A1: total >= 5 AND at least two situations >= 2 each.
 * - Otherwise: 'none'.
 */
export function scoreSpeaking(input: SpeakingScoreInput): SpeakingLevel {
  const clampedSituations = input.situations
    .slice(0, 3)
    .map((s) => clampSpeakingScore(s, 3));
  const sorted = [...clampedSituations].sort((a, b) => b - a);
  const s1 = sorted[0] ?? 0;
  const s2 = sorted[1] ?? 0;
  const s3 = sorted[2] ?? 0;
  const interlocutor = clampSpeakingScore(input.interlocutor, 1);
  const total = roundPoints(interlocutor + s1 + s2 + s3);
  const atLeastTwoGe2 = [s1, s2, s3].filter((s) => s >= 2).length >= 2;
  const bestTwoSum = roundPoints(s1 + s2);

  if (total >= 6 && bestTwoSum >= 5 && atLeastTwoGe2) {
    return 'A2';
  }
  if (total >= 5 && atLeastTwoGe2) {
    return 'A1';
  }
  return 'none';
}

/**
 * Computes the overall exam verdict across all parts in `spec.parts`.
 *
 * Rules:
 * - Any part failed (`'none'`) -> `'none'` ('Neišlaikyta').
 * - Any part `'unknown'` (and none failed, so the final outcome could still change) -> `'incomplete'`.
 * - All three parts `'A2'` -> `'A2'`.
 * - Any part `'A1'` (none failed, none unknown) -> `'A1'`.
 */
export function verdict(
  spec: ExamSpec,
  parts:
    | readonly PartScore[]
    | Readonly<Record<string, PartScore | PartLevel>>,
): Verdict {
  const perPart: Record<PartId, PartLevel> = {
    rw: 'unknown',
    listen: 'unknown',
    speak: 'unknown',
  };

  if (Array.isArray(parts)) {
    for (const p of parts) {
      perPart[p.partId] = p.level;
    }
  } else {
    const record = parts as Readonly<Record<string, PartScore | PartLevel>>;
    for (const [key, val] of Object.entries(record)) {
      const pid = key as PartId;
      if (typeof val === 'string') {
        perPart[pid] = val;
      } else if (val && typeof val === 'object' && 'level' in val) {
        perPart[pid] = val.level;
      }
    }
  }

  const partIds: PartId[] =
    spec.parts.length > 0
      ? spec.parts.map((p) => p.id)
      : (['rw', 'listen', 'speak'] as PartId[]);

  const failedParts = partIds.filter((id) => perPart[id] === 'none');
  const unknownParts = partIds.filter((id) => perPart[id] === 'unknown');
  const a1Parts = partIds.filter((id) => perPart[id] === 'A1');

  if (failedParts.length > 0) {
    const reasons = failedParts.map(
      (id) => `Part '${id}' failed (Neišlaikyta).`,
    );
    return {
      level: 'none',
      perPart,
      reasons,
    };
  }

  if (unknownParts.length > 0) {
    const reasons = unknownParts.map(
      (id) =>
        `Part '${id}' is unscored or has pending self-scored items, so the final result could still change.`,
    );
    return {
      level: 'incomplete',
      perPart,
      reasons,
    };
  }

  if (a1Parts.length === 0) {
    return {
      level: 'A2',
      perPart,
      reasons: ['All exam parts passed at A2 level.'],
    };
  }

  return {
    level: 'A1',
    perPart,
    reasons: [
      `All exam parts passed; achieved A1 overall because part(s) ${a1Parts.map((id) => `'${id}'`).join(', ')} reached A1.`,
    ],
  };
}

/**
 * Convenience function that scores an entire mock attempt against a specification and answer keys.
 * Throws an Error if `mock.specVersion !== spec.specVersion`.
 */
export function scoreAttempt(
  spec: ExamSpec,
  mock: Mock,
  keys: AnswerKeyMap,
  answers: AnswerMap,
): AttemptResult {
  if (mock.specVersion !== spec.specVersion) {
    throw new Error(
      `Spec version mismatch: mock has specVersion ${mock.specVersion}, expected ${spec.specVersion}.`,
    );
  }

  const itemScores: ItemScore[] = mock.items.map((item) =>
    scoreItem(item, keys[item.id], answers[item.id]),
  );

  const blockScores: BlockScore[] = spec.blocks.map((blockSpec) =>
    scoreBlock(blockSpec, mock.items, itemScores),
  );

  const partScores: PartScore[] = spec.parts.map((partSpec) =>
    scorePart(spec, blockScores, partSpec.id),
  );

  const finalVerdict = verdict(spec, partScores);

  const clonedAnswers: Record<string, ItemAnswer> = {};
  for (const [k, v] of Object.entries(answers)) {
    clonedAnswers[k] = cloneAnswerValue(v);
  }

  return {
    specVersion: spec.specVersion,
    mockId: mock.mockId,
    mockRev: mock.rev,
    answers: clonedAnswers,
    blocks: blockScores,
    verdict: finalVerdict,
  };
}

/**
 * Validates an `ExamSpec` and returns a list of validation error messages (empty when valid).
 * Checks:
 * - unique part and block IDs
 * - every block references an existing part
 * - every `requires` references an existing block (and not itself)
 * - `0 <= passPoints <= maxPoints` and `maxPoints > 0`
 * - `rw` blocks total 50 points and `listen` blocks total 20 points
 */
export function validateSpec(spec: ExamSpec): string[] {
  const errors: string[] = [];

  const partIds = new Set<string>();
  for (const part of spec.parts) {
    if (partIds.has(part.id)) {
      errors.push(`Duplicate part id '${part.id}'.`);
    }
    partIds.add(part.id);
  }

  const blockIds = new Set<string>();
  for (const block of spec.blocks) {
    if (blockIds.has(block.id)) {
      errors.push(`Duplicate block id '${block.id}'.`);
    }
    blockIds.add(block.id);

    if (!partIds.has(block.part)) {
      errors.push(`Block '${block.id}' references unknown part '${block.part}'.`);
    }

    if (block.maxPoints <= 0) {
      errors.push(`Block '${block.id}' must have maxPoints > 0 (got ${block.maxPoints}).`);
    }
    if (block.passPoints < 0 || block.passPoints > block.maxPoints) {
      errors.push(
        `Block '${block.id}' has passPoints (${block.passPoints}) exceeding maxPoints (${block.maxPoints}) or below 0.`,
      );
    }
  }

  for (const block of spec.blocks) {
    if (block.requires !== undefined) {
      if (block.requires === block.id) {
        errors.push(`Block '${block.id}' cannot require itself.`);
      } else if (!blockIds.has(block.requires)) {
        errors.push(
          `Block '${block.id}' requires non-existent block '${block.requires}'.`,
        );
      }
    }
  }

  const rwBlocksTotal = spec.blocks
    .filter((b) => b.part === 'rw')
    .reduce((sum, b) => sum + b.maxPoints, 0);
  if (rwBlocksTotal !== 50) {
    errors.push(`Part 'rw' blocks must total 50 points (got ${rwBlocksTotal}).`);
  }

  const rwPart = spec.parts.find((p) => p.id === 'rw');
  if (rwPart && rwPart.maxPoints !== 50) {
    errors.push(`Part 'rw' maxPoints must be 50 (got ${rwPart.maxPoints}).`);
  }

  const listenBlocksTotal = spec.blocks
    .filter((b) => b.part === 'listen')
    .reduce((sum, b) => sum + b.maxPoints, 0);
  if (listenBlocksTotal !== 20) {
    errors.push(
      `Part 'listen' blocks must total 20 points (got ${listenBlocksTotal}).`,
    );
  }

  const listenPart = spec.parts.find((p) => p.id === 'listen');
  if (listenPart && listenPart.maxPoints !== 20) {
    errors.push(
      `Part 'listen' maxPoints must be 20 (got ${listenPart.maxPoints}).`,
    );
  }

  return errors;
}

function hasValidAutoKey(item: Item, key: AnswerKey | undefined): boolean {
  if (key === undefined || key === null) {
    return false;
  }
  if (typeof key === 'string') {
    return key.trim() !== '';
  }
  if (Array.isArray(key)) {
    return key.length > 0 && key.every((k) => typeof k === 'string' && k.trim() !== '');
  }
  if (isStringRecord(key)) {
    const entries = Object.entries(key);
    return (
      entries.length > 0 &&
      entries.every(([, val]) => {
        if (typeof val === 'string') {
          return val.trim() !== '';
        }
        if (Array.isArray(val)) {
          return val.length > 0 && val.every((v) => typeof v === 'string' && v.trim() !== '');
        }
        return false;
      })
    );
  }
  return false;
}

/**
 * Validates a `Mock` and its `AnswerKeyMap` against an `ExamSpec`.
 * Returns a list of validation error messages (empty when valid).
 * Checks:
 * - specVersion compatibility
 * - unique item IDs
 * - every item's `blockId` exists in `spec.blocks`
 * - sum of item points per block equals `block.maxPoints`
 * - every `auto` item has a non-empty answer key
 */
export function validateMock(
  spec: ExamSpec,
  mock: Mock,
  keys: AnswerKeyMap,
): string[] {
  const errors: string[] = [];

  if (mock.specVersion !== spec.specVersion) {
    errors.push(
      `Mock specVersion (${mock.specVersion}) does not match ExamSpec specVersion (${spec.specVersion}).`,
    );
  }

  const blockMap = new Map<string, BlockSpec>();
  for (const block of spec.blocks) {
    blockMap.set(block.id, block);
  }

  const itemIds = new Set<string>();
  const pointsPerBlock = new Map<string, number>();
  for (const block of spec.blocks) {
    pointsPerBlock.set(block.id, 0);
  }

  for (const item of mock.items) {
    if (itemIds.has(item.id)) {
      errors.push(`Duplicate item id '${item.id}'.`);
    }
    itemIds.add(item.id);

    if (!blockMap.has(item.blockId)) {
      errors.push(
        `Item '${item.id}' references non-existent blockId '${item.blockId}'.`,
      );
    } else {
      pointsPerBlock.set(
        item.blockId,
        roundPoints((pointsPerBlock.get(item.blockId) ?? 0) + item.points),
      );
    }

    if (item.scoring === 'auto' && !hasValidAutoKey(item, keys[item.id])) {
      errors.push(`Auto-scored item '${item.id}' is missing a valid answer key.`);
    }
  }

  for (const block of spec.blocks) {
    const sum = pointsPerBlock.get(block.id) ?? 0;
    if (sum !== block.maxPoints) {
      errors.push(
        `Block '${block.id}' item points sum to ${sum}, expected ${block.maxPoints}.`,
      );
    }
  }

  return errors;
}
