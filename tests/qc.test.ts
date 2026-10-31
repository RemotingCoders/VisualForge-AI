import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload, getQcSessions, saveImageLevel } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { metaPost } from '../src/lib/engine/providers';
import { buildQCCoco, buildQCYolo } from '../src/lib/coco';
import { POST as generatePOST } from '../src/app/api/generate/route';
import { GET as qcRevealGET } from '../src/app/api/qc-reveal/route';
import { POST as qcSessionPOST } from '../src/app/api/qc-session/route';
import type { Difference, Providers } from '../src/lib/engine/types';

// QC completion (fake providers only — no paid calls):
//  - several defects on ONE big SAM region (the whole part) must ALL land: overlap is
//    judged against accepted defects' MEASURED boxes, never the region box;
//  - the planner anchors each defect with its own targetBox inside the region;
//  - Spark classification lands on the differences; confidence < 0.6 is needs_review
//    and splits out of the main COCO/YOLO export;
//  - a short QC level publishes partial with a "Generated N of M defects" notice
//    (game mode would fail loudly instead);
//  - reveal is QC-only, sessions are saved, count works from 1, and a transient
//    network failure is retried exactly once inside metaPost.

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());

/** Fake Muse: paints solid blue exactly inside the paste box it is given (the box
 *  derived from the candidate's targetBox), leaves everything else untouched. */
const paintPatternBlue = async (imageRef: string, region?: { bbox: { x: number; y: number; width: number; height: number } }) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const b = region?.bbox ?? { x: 12, y: 12, width: Math.max(1, info.width - 24), height: Math.max(1, info.height - 24) };
  for (let y = Math.max(0, b.y); y < Math.min(info.height, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(info.width, b.x + b.width); x++) {
    const o = (y * info.width + x) * 3; out[o] = 30; out[o + 1] = 30; out[o + 2] = 220;
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};

const overlaps = (a: Difference['bbox'], b: Difference['bbox']) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

afterEach(() => { vi.unstubAllEnvs(); });

describe('QC generation on a single whole-part region (fake providers)', () => {
  it('delivers 3 defects on ONE region without region-overlap discards, then classifies them', async () => {
    let seenMode: string | undefined;
    const fake: Providers = {
      // SAM returns ONE region: the entire part (the field case that used to cap QC at 1 defect).
      segmentation: {
        name: 'fake', isMock: true,
        segment: async (_img: string, _w: number, _h: number, _concepts?: string[], mode?: string) => {
          seenMode = mode;
          return [{ id: 'part', bbox: { x: 10, y: 10, width: 180, height: 140 } }];
        },
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [
          { id: 'd1', regionId: 'part', type: 'scratch', description: 'scratch on the upper-left edge', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 20, height: 14 }, partConcept: 'flange edge' },
          { id: 'd2', regionId: 'part', type: 'dent', description: 'dent near the central bore', editPrompt: 'add a dent', targetBox: { x: 90, y: 65, width: 20, height: 14 }, partConcept: 'central bore' },
          { id: 'd3', regionId: 'part', type: 'corrosion', description: 'corrosion by a mounting hole', editPrompt: 'add corrosion', targetBox: { x: 150, y: 115, width: 20, height: 14 }, partConcept: 'mounting hole' },
        ],
        verify: async () => ({ ok: true, notes: 'ok' }),
        // Classifies what it SEES (keyed here by the planned type it is shown):
        // the scratch is really a crack, and Spark is unsure about the dent.
        classifyDefects: async (items: { index: number; plannedType: string }[]) => items.map(i => ({
          index: i.index,
          defectType: i.plannedType === 'scratch' ? 'crack' : i.plannedType,
          severity: i.plannedType === 'dent' ? 4 : i.plannedType === 'scratch' ? 2 : 3,
          confidence: i.plannedType === 'dent' ? 0.5 : i.plannedType === 'scratch' ? 0.95 : 0.9,
          label: `${i.plannedType} as seen in the crop`,
        })),
      },
      // No editFullImage: one-pass unavailable, so the crop pipeline must deliver all 3.
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('qc', true, 3);
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 3, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seenMode).toBe('qc'); // SAM concept listing was asked for parts/features, not objects
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(3);
    for (let i = 0; i < diffs.length; i++) for (let j = i + 1; j < diffs.length; j++)
      expect(overlaps(diffs[i].bbox, diffs[j].bbox), `defects ${i} and ${j} overlap`).toBe(false);
    // Classification landed; the planned type stays in `type` (delivery order may
    // vary — a topped-up defect arrives after the first-pass ones).
    expect(diffs.map(d => d.type).sort()).toEqual(['corrosion', 'dent', 'scratch']);
    const byPlanned = new Map(diffs.map(d => [d.type, d]));
    expect(byPlanned.get('scratch')!.classifiedType).toBe('crack'); // planned scratch, seen as crack
    expect(byPlanned.get('scratch')!.classifiedSeverity).toBe(2);
    expect(byPlanned.get('dent')!.classifiedType).toBe('dent');
    expect(diffs.filter(d => (d.classificationConfidence ?? 1) < 0.6).map(d => d.type)).toEqual(['dent']);
    expect(getLevelPayload(job.levelId!)!.notice).toBeUndefined(); // full delivery — no partial notice
    // Export split: main file uses CLASSIFIED types and excludes the low-confidence dent;
    // the needs_review file contains exactly that dent.
    const main = buildQCCoco(diffs, 200, 160, 'modified.png');
    expect(main.annotations).toHaveLength(2);
    const catNames = (coco: typeof main) => coco.annotations.map(a => coco.categories.find(c => c.id === a.category_id)!.name).sort();
    expect(catNames(main)).toEqual(['corrosion', 'crack']); // classified types, not planned
    const review = buildQCCoco(diffs, 200, 160, 'modified.png', 'review');
    expect(review.annotations).toHaveLength(1);
    expect(catNames(review)).toEqual(['dent']);
    expect(buildQCYolo(diffs, 200, 160).trim().split('\n')).toHaveLength(2);
    expect(buildQCYolo(diffs, 200, 160, 'review').trim().split('\n')).toHaveLength(1);
  });

  it('publishes a partial QC level with a notice instead of failing when short', async () => {
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 180, height: 140 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [
          { id: 'd1', regionId: 'part', type: 'scratch', description: 'one scratch', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 20, height: 14 }, partConcept: 'flange edge' },
        ],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('qc', true, 2);
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done'); // game mode would FAIL here
    expect(getDifferences(job.levelId!)!).toHaveLength(1);
    expect(getLevelPayload(job.levelId!)!.notice).toBe('Generated 1 of 2 defects');
  });

  it('accepts count from 1 in QC mode at the route', async () => {
    vi.stubEnv('VF_ACCESS_CODE', '');
    const res = await generatePOST(new Request('http://localhost/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.0.1' },
      body: JSON.stringify({ mode: 'qc', count: 1 }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).isMock).toBe(true); // offline MOCK path — no paid call in tests
  });
});

describe('QC reveal + trainer session', () => {
  const diff = (id: string, extra: Partial<Difference> = {}): Difference => ({
    id, type: 'scratch', description: `${id} defect`, bbox: { x: 10, y: 10, width: 20, height: 12 },
    bbox_normalized: { x: 0.05, y: 0.06, width: 0.1, height: 0.075 }, mask_url: null,
    severity: 'medium', verification_status: 'verified', verifier_notes: 'ok', ...extra,
  });
  const img = 'data:image/png;base64,iVBORw0KGgo=';

  it('reveals a QC level (classified type wins) but 403s a game level', async () => {
    const qcId = saveImageLevel({
      differences: [diff('q1', { classifiedType: 'crack', classifiedSeverity: 3, classificationConfidence: 0.9, classificationLabel: 'thin crack' })],
      original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'qc',
    });
    const res = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${qcId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.differences).toHaveLength(1);
    expect(body.differences[0].type).toBe('crack');
    expect(body.differences[0].plannedType).toBe('scratch');
    expect(body.differences[0].severity).toBe(3);

    const gameId = saveImageLevel({ differences: [diff('g1')], original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'game' });
    const forbidden = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${gameId}`));
    expect(forbidden.status).toBe(403); // a game level's boxes are its answers — never revealed
  });

  it('saves a trainer session with server-computed accuracy, QC levels only', async () => {
    const qcId = saveImageLevel({ differences: [diff('q1')], original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'qc' });
    const res = await qcSessionPOST(new Request('http://localhost/api/qc-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levelId: qcId, correct: 3, missed: 1, falsePositives: 1, durationSec: 42 }),
    }));
    expect(res.status).toBe(200);
    const sessions = getQcSessions(qcId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ correct: 3, missed: 1, falsePositives: 1, durationSec: 42 });
    expect(sessions[0].accuracy).toBeCloseTo(0.75); // 3 / (3 + 1), computed server-side

    const gameId = saveImageLevel({ differences: [diff('g1')], original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'game' });
    const forbidden = await qcSessionPOST(new Request('http://localhost/api/qc-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levelId: gameId, correct: 1, missed: 0, falsePositives: 0, durationSec: 5 }),
    }));
    expect(forbidden.status).toBe(403);
    expect(getQcSessions(gameId)).toHaveLength(0);
  });
});

describe('metaPost network retry', () => {
  const env = { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key', VF_NETWORK_RETRY_DELAY_MS: '0' };
  it('retries a transient network failure exactly once, then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ hello: 'world' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(metaPost('/v1/test', {}, env, fetchFn)).resolves.toEqual({ hello: 'world' });
    expect(calls).toBe(2);
  });

  it('does NOT retry an HTTP error — the API answered, the request is the problem', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(metaPost('/v1/test', {}, env, fetchFn)).rejects.toThrow('HTTP 500');
    expect(calls).toBe(1);
  });
});
