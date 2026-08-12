// Photo screening.
//
// Automated screening only runs if GOOGLE_VISION_API_KEY is set. Without it,
// uploads are accepted and the app relies on user reports alone — which is
// reactive, so set the key before letting strangers in.
//
// Get a key: console.cloud.google.com -> new project -> enable "Cloud Vision
// API" -> Credentials -> Create API key. Free tier covers 1000 images/month.

const RANK = {
  UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5,
};

// POSSIBLE is deliberately strict for adult content. A wrongly-blocked photo
// is a mild annoyance; a wrongly-allowed one is a real problem.
const LIMITS = { adult: 3, racy: 4, violence: 4, medical: 5 };

export const MODERATION_ON = !!process.env.GOOGLE_VISION_API_KEY;

export async function screenPhoto(base64) {
  if (!MODERATION_ON || !base64) return { ok: true, checked: false };

  try {
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

    if (!res.ok) {
      // Fail open rather than blocking every upload when the API is down,
      // but log it loudly so it gets noticed.
      console.error('Vision API returned', res.status);
      return { ok: true, checked: false };
    }

    const data = await res.json();
    const flags = data.responses?.[0]?.safeSearchAnnotation;
    if (!flags) return { ok: true, checked: false };

    for (const [key, limit] of Object.entries(LIMITS)) {
      if ((RANK[flags[key]] ?? 0) >= limit) {
        return { ok: false, checked: true, reason: key };
      }
    }
    return { ok: true, checked: true };
  } catch (e) {
    console.error('Photo screening failed:', e.message);
    return { ok: true, checked: false };
  }
}

export const REJECTION_TEXT = {
  adult:    "That photo looks like it contains nudity or sexual content, so it can't be posted.",
  racy:     "That photo looks too suggestive to post here.",
  violence: "That photo looks like it contains graphic violence, so it can't be posted.",
  medical:  "That photo looks like graphic medical content, so it can't be posted.",
};
