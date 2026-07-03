// Server-only wrapper around the Lovable AI Gateway /v1/embeddings endpoint.
// Never import this from client-reachable module scope; keep it inside
// server-function handlers (createServerFn handler body or server route).

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/embeddings";
const MODEL = "openai/text-embedding-3-small";
const DIMS = 1536;
const BATCH = 96; // OpenAI per-request cap on this model is generous; keep well under

export async function embedTexts(
  inputs: string[],
  opts?: { model?: string; dimensions?: number },
): Promise<number[][]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY on the server");
  const model = opts?.model ?? MODEL;
  const dimensions = opts?.dimensions ?? DIMS;

  const out: number[][] = new Array(inputs.length);
  for (let start = 0; start < inputs.length; start += BATCH) {
    const chunk = inputs.slice(start, start + BATCH);
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({ model, input: chunk, dimensions }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Embeddings error ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    for (const item of json.data) {
      out[start + item.index] = item.embedding;
    }
  }
  return out;
}

export async function embedQuery(input: string): Promise<number[]> {
  const [v] = await embedTexts([input]);
  return v;
}

// Cheap stable content hash for dedupe. Uses FNV-1a 64-bit — good enough for
// content-change detection (no cryptographic use).
export function contentHash(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ BigInt(input.charCodeAt(i))) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16);
}

export const EMBEDDING_DIMS = DIMS;
