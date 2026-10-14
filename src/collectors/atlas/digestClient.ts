import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal HTTP Digest-auth client for the Atlas Administration API.
 *
 * The Atlas Admin API authenticates programmatic API keys with HTTP Digest
 * (RFC 2617, MD5 / qop=auth). Node's fetch has no built-in digest support, so
 * we do the standard two-step handshake:
 *   1. Unauthenticated request → 401 with a `WWW-Authenticate: Digest ...` challenge.
 *   2. Re-request with an `Authorization: Digest ...` header computed from the
 *      challenge, the credentials, and a client nonce.
 */
export interface DigestCredentials {
  username: string; // Atlas public key
  password: string; // Atlas private key
}

export class DigestClient {
  private nc = 0;

  constructor(
    private readonly creds: DigestCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** GET a URL with digest auth, returning parsed JSON. */
  async getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const first = await this.fetchImpl(url, { headers });
    if (first.status !== 401) {
      if (!first.ok) throw await httpError(first, url);
      return (await first.json()) as T;
    }

    const challenge = first.headers.get("www-authenticate");
    if (!challenge || !/digest/i.test(challenge)) {
      throw new Error(`Expected Digest challenge from ${url}, got: ${challenge ?? "none"}`);
    }

    const authHeader = this.buildAuthHeader("GET", url, parseChallenge(challenge));
    const second = await this.fetchImpl(url, {
      headers: { ...headers, Authorization: authHeader },
    });
    if (!second.ok) throw await httpError(second, url);
    return (await second.json()) as T;
  }

  private buildAuthHeader(
    method: string,
    url: string,
    c: Record<string, string>,
  ): string {
    const { username, password } = this.creds;
    const uri = new URL(url).pathname + new URL(url).search;
    const realm = c.realm ?? "";
    const nonce = c.nonce ?? "";
    const qop = c.qop ?? "auth";
    const algorithm = c.algorithm ?? "MD5";
    const cnonce = randomBytes(8).toString("hex");
    this.nc += 1;
    const ncValue = this.nc.toString(16).padStart(8, "0");

    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = md5(`${ha1}:${nonce}:${ncValue}:${cnonce}:${qop}:${ha2}`);

    const parts = [
      `username="${username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${algorithm}`,
      `qop=${qop}`,
      `nc=${ncValue}`,
      `cnonce="${cnonce}"`,
      `response="${response}"`,
    ];
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(", ")}`;
  }
}

/** Parse a `WWW-Authenticate: Digest ...` header into key/value pairs. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^digest\s+/i, "");
  // Split on commas not inside quotes.
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]!] = m[2] ?? m[3] ?? "";
  }
  return out;
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

async function httpError(res: Response, url: string): Promise<Error> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  return new Error(`Atlas API ${res.status} ${res.statusText} for ${url}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}
