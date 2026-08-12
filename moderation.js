// Photo screening.
//
// Automated screening only runs if GOOGLE_VISION_API_KEY is set. Without it,
// uploads are accepted and the app relies on user reports alone — which is
// reactive, so set the key before letting strangers in.

const RANK = {
  UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5,
};

// A wrongly-blocked photo is a mild annoyance. A wrongly-allowed one is not.
// So every category triggers at POSSIBLE, which is one step below Google's
// own "this is probably fine" line.
const LIMITS = { adult: 3, racy: 3, violence: 3, medical: 3 };

export const MODERATION_ON = !!process.env.GOOGLE_VISION_API_KEY;

// Raw scores, no verdict. Used by the check endpoint so thresholds can be
// tuned against real photos instead of guessed at.
export async function rawScores(base64) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }],
        }],
      }),
    }
  );
  if (!res.ok) throw new Error(`Vision API returned ${res.status}`);
  const data = await res.json();
  if (data.responses?.[0]?.error) throw new Error(data.responses[0].error.message);
  return data.responses?.[0]?.safeSearchAnnotation ?? null;
}

export async function screenPhoto(base64) {
  if (!MODERATION_ON || !base64) return { ok: true, checked: false };

  try {
    const flags = await rawScores(base64);
    if (!flags) return { ok: true, checked: false };

    console.log('SafeSearch:', JSON.stringify(flags));

    for (const [key, limit] of Object.entries(LIMITS)) {
      if ((RANK[flags[key]] ?? 0) >= limit) {
        return { ok: false, checked: true, reason: key, scores: flags };
      }
    }
    return { ok: true, checked: true, scores: flags };
  } catch (e) {
    // Fail open rather than blocking every upload when the API is down,
    // but log it loudly so it gets noticed.
    console.error('Photo screening failed:', e.message);
    return { ok: true, checked: false };
  }
}

export const REJECTION_TEXT = {
  adult:    "That photo looks like it contains nudity or sexual content, so it can't be posted.",
  racy:     "That photo looks too suggestive to post here.",
  violence: "That photo looks like it contains violence or injury, so it can't be posted.",
  medical:  "That photo looks like graphic medical content, so it can't be posted.",
};

export { LIMITS, RANK };
