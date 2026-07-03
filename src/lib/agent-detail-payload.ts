// Small pure helpers shared by the Agent Dashboard and its detail route.
// Encodes a JSON payload to a URL-safe base64 string.

export type DetailPayload = {
  kind: "row" | "aggregate";
  projectId?: string;
  projectLabel?: string;
  title: string;
  detail?: string;
  severity?: "high" | "med" | "low" | "ok";
  source?: string;
  person?: string;
  stage?: string;
  email?: string;
  row?: Record<string, unknown>;
};

function b64UrlEncode(str: string): string {
  if (typeof window === "undefined") {
    // Node
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof window === "undefined") {
    return Buffer.from(b64, "base64").toString("utf8");
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeDetailPayload(p: DetailPayload): string {
  return b64UrlEncode(JSON.stringify(p));
}
export function decodeDetailPayload(s: string): DetailPayload {
  return JSON.parse(b64UrlDecode(s)) as DetailPayload;
}
