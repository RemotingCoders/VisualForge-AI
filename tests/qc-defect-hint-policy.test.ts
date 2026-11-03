import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration, sanitizeDefectHintForPrompts, isImagePolicyViolation, IMAGE_POLICY_USER_MESSAGE } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import type { PlannedChange, Providers } from '../src/lib/engine/types';

// Muse Image content_policy_violation vs the QC defect hint — fake providers
// only, no real calls (field case, Render 2026-11-03: a hint with "burnt"
// failed EVERY edit of the job because it rode inside every prompt):
//  - filter-tripping words are softened BEFORE the hint reaches any prompt;
//  - a policy 400 on a prompt WITH the hint retries that edit ONCE without
//    the hint sentence; success disables the hint for the rest of the job and
//    marks the level "defect request could not be applied by the image model";
//  - a policy 400 again — or on a hint-less prompt — aborts the job at once
//    with the plain-language message, without consuming more candidates.

const POLICY_ERROR = () => new Error('Meta API /images/edits → HTTP 400 content_policy_violation: {"error":{"message":"This request was rejected by the safety system","code":"content_policy_violation"}}');
const HINT = 'rust on the bolt heads, a loose solder joint';
const SENTENCE = `The inspector asked for these defects, in priority order: ${HINT}.`;

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const paintPatternBlue = async (imageRef: string, region?: { bbox: { x: number; y: number; width: number; height: number } }) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const b = region?.bbox ?? { x: 12, y: 12, width: Math.max(1, info.width - 24), height: Math.max(1, info.height - 24) };
  for (let y = Math.max(0, b.y); y < Math.min(info.height, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(info.width, b.x + b.width); x++) {
    const o = (y * info.width + x) * 3; out[o] = 30; out[o + 1] = 30; out[o + 2] = 220;
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};
const paintRects = async (imageRef: string, rects: { x: number; y: number; width: number; height: number; rgb: [number, number, number] }[]) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const o = (y * info.width + x) * 3; out[o] = r.rgb[0]; out[o + 1] = r.rgb[1]; out[o + 2] = r.rgb[2];
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const RUST: PlannedChange = { id: 'rust', regionId: 'part', type: 'corrosion', description: 'rust bloom on the bolt heads', editPrompt: 'add rust on the bolt heads', targetBox: { x: 30, y: 30, width: 24, height: 18 }, partConcept: 'bolt heads' };
const SCRATCH: PlannedChange = { id: 'scratch', regionId: 'part', type: 'scratch', description: 'long scratch across the flange', editPrompt: 'add a scratch', targetBox: { x: 180, y: 140, width: 24, height: 18 }, partConcept: 'flange face' };

describe('defect-hint sanitizing + policy detection', () => {
  it('softens every filter-tripping term, keeps capitalization, reports replacements', () => {
    const { text, replacements } = sanitizeDefectHintForPrompts('Burnt joint, a burned trace, scorched casing, fire and smoke damage, an exploded capacitor, a destroyed via, blood stain');
    expect(text).toBe('Overheated joint, a overheated trace, discolored casing, heat and discoloration damage, an damaged capacitor, a damaged via, discolored stain');
    expect(replacements.map(r => r.from.toLowerCase())).toEqual(['burnt', 'burned', 'scorched', 'fire', 'smoke', 'exploded', 'destroyed', 'blood']);
    expect(sanitizeDefectHintForPrompts(HINT)).toEqual({ text: HINT, replacements: [] }); // clean hint untouched
  });

  it('detects content_policy_violation in error messages only', () => {
    expect(isImagePolicyViolation(POLICY_ERROR())).toBe(true);
    expect(isImagePolicyViolation(new Error('HTTP 500 something else'))).toBe(false);
  });
});

describe('content_policy_violation on QC edits (fake providers)', () => {
  it('one-pass: retries once without the hint, disables it, and marks the level', async () => {
    const editPrompts: string[] = [];
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        moderateTheme: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [],
        verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => pairs.map(p => ({ index: p.index, ok: true, description: 'a rust bloom on the bolt head', type: 'corrosion', notes: 'fake review ok', sameChangeAs: -1 })),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }),
        editFullImage: async (imageRef: string, prompt: string) => {
          editPrompts.push(prompt);
          if (prompt.includes('The inspector asked')) throw POLICY_ERROR(); // the fake image filter rejects the hinted prompt
          return paintRects(imageRef, [{ x: 400, y: 300, width: 40, height: 30, rgb: [230, 30, 30] }]);
        },
      },
    };
    const job = createJob('qc', true, 1, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(800, 600, [120, 120, 120]) }, 1, providers);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(editPrompts).toHaveLength(2); // original + exactly one retry
    expect(editPrompts[0]).toContain(SENTENCE);
    expect(editPrompts[1]).not.toContain('The inspector asked');
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.notice).toContain('defect request could not be applied by the image model'); // the level is marked
    expect(payload.defectHint).toBe(HINT); // the request itself is still stored/shown as asked
    expect(getDifferences(job.levelId!)).toHaveLength(1);
  });

  it('crop path: first candidate retries without the hint, later candidates never send it', async () => {
    const cropPrompts: string[] = [];
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        moderateTheme: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [RUST, SCRATCH],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      // No editFullImage: the crop pipeline is the path under test.
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }, prompt: string) => {
          cropPrompts.push(prompt);
          if (prompt.includes('The inspector asked')) throw POLICY_ERROR();
          return paintPatternBlue(imageRef, region);
        },
        generateScene: async () => ({ image: '' }),
      },
    };
    const job = createJob('qc', true, 2, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, providers);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(cropPrompts).toHaveLength(3); // candidate 1: hinted + retry; candidate 2: clean from the start
    expect(cropPrompts[0]).toContain(SENTENCE);
    expect(cropPrompts[1]).not.toContain('The inspector asked');
    expect(cropPrompts[2]).not.toContain('The inspector asked'); // hint stayed disabled for the rest of the job
    expect(getDifferences(job.levelId!)!.map(d => d.description)).toEqual([RUST.description, SCRATCH.description]);
    expect(getLevelPayload(job.levelId!)!.notice).toContain('defect request could not be applied by the image model');
  });

  it('with a hint: failing again without it aborts immediately — no more candidates are tried', async () => {
    let fullCalls = 0; let cropCalls = 0;
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        moderateTheme: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [RUST, SCRATCH],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: async () => { cropCalls++; throw POLICY_ERROR(); },
        generateScene: async () => ({ image: '' }),
        editFullImage: async () => { fullCalls++; throw POLICY_ERROR(); }, // filter rejects even the hint-less retry
      },
    };
    const job = createJob('qc', true, 2, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, providers);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toBe(IMAGE_POLICY_USER_MESSAGE);
    expect(fullCalls).toBe(2); // one hinted attempt + one retry — then abort
    expect(cropCalls).toBe(0); // no candidate was consumed after the abort
  });

  it('without a hint: a policy 400 aborts at once, without consuming candidates', async () => {
    let fullCalls = 0; let cropCalls = 0;
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [RUST, SCRATCH],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: async () => { cropCalls++; throw POLICY_ERROR(); },
        generateScene: async () => ({ image: '' }),
        editFullImage: async () => { fullCalls++; throw POLICY_ERROR(); },
      },
    };
    const job = createJob('qc', true, 2, 'medium'); // no hint at all
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, providers);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toBe(IMAGE_POLICY_USER_MESSAGE);
    expect(fullCalls).toBe(1); // no retry without a hint to strip
    expect(cropCalls).toBe(0); // aborted before the crop candidates
  });

  it('a "burnt" hint is softened before ANY prompt: planner and edits see "overheated", the level stores the original', async () => {
    const seen: { planHint?: string; editPrompts: string[] } = { editPrompts: [] };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        moderateTheme: async () => ({ ok: true, reason: 'ok' }),
        plan: async (_i: string, _r: unknown, _m: string, _c: number, _d?: string, defectHint?: string) => { seen.planHint = defectHint; return [RUST]; },
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }, prompt: string) => { seen.editPrompts.push(prompt); return paintPatternBlue(imageRef, region); },
        generateScene: async () => ({ image: '' }),
      },
    };
    try {
      const job = createJob('qc', true, 1, 'medium', 'a burnt solder joint near the chip');
      await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, providers);
      expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
      expect(seen.planHint).toBe('a overheated solder joint near the chip'); // planner prompt copy softened
      expect(seen.editPrompts.length).toBeGreaterThan(0);
      expect(seen.editPrompts.every(p => p.includes('overheated') && !/burnt/i.test(p))).toBe(true);
      expect(getLevelPayload(job.levelId!)!.defectHint).toBe('a burnt solder joint near the chip'); // stored as requested
      expect(infoSpy.mock.calls.some(args => String(args[0]).includes('wording softened'))).toBe(true); // replacement logged
    } finally { infoSpy.mockRestore(); }
  });
});
