// model-image-budget.ts — how many images, and how many bytes of them, one
// request to a model carries. One budget for every provider, read in two
// places that must agree: the tool seam (`admitModelImage`, @nodal-agents/tools:
// what one call may attach) and the request builder (`withinImageBudget`,
// @nodal-agents/llm: what one request sends, newest first).
//
// Why a budget at all (review of #798, P2-3): an image stays in the
// transcript and is sent again on every turn until compaction retires its
// result, the parallel read pre-pass attaches several in one turn, and an MCP
// call can return many. The per-image cap alone let a request grow without
// bound.
//
// The numbers come from the providers' documented limits, read on 2026-10-19:
//   - Google Gemini: "Inline image data limits your total request size (text
//     prompts, system instructions, and inline bytes) to 20MB"
//     (ai.google.dev/gemini-api/docs/image-understanding). The tightest byte
//     limit, and it counts the text too: 10 MiB of images is ~13.3 MiB of
//     base64, which leaves room for the conversation.
//   - Anthropic: 32 MB per request on the standard endpoints; up to 100 or
//     600 images per request, but "If a single API request contains more than
//     20 images, a stricter per-image dimension limit applies to every image
//     in that request" (platform.claude.com/docs/en/build-with-claude/vision).
//     20 images keeps every request under the normal limits.
//   - OpenAI: "Up to 512 MB total payload per request", "Up to 1,500 images
//     per request" (developers.openai.com/api/docs/guides/images-vision).
// Mistral's page lists the questions of its limits without their answers in
// the text served (docs.mistral.ai/capabilities/vision), so no number here
// rests on it.

/** At most this many images in one request. */
export const MODEL_REQUEST_MAX_IMAGES = 20;

/** At most this many bytes of images (decoded) in one request. */
export const MODEL_REQUEST_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
