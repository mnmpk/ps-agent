import type { IncomingMessage } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal streaming `multipart/form-data` parser — just enough to accept a batch
 * of uploaded diagnostic files without adding a dependency. Each file part is
 * written to a TEMP FILE on disk (not buffered in memory), so a multi-GB FTDC
 * upload stays bounded and `importBundle` can stream each file by path.
 *
 * Caller is responsible for calling `cleanup()` when done (removes the temp dir).
 */
export interface MultipartFile {
  /** Form field name (unused by us but kept for completeness). */
  field: string;
  /** Original filename from the Content-Disposition header. */
  filename: string;
  /** Absolute path to the temp file holding this part's bytes. */
  path: string;
  size: number;
}

export interface MultipartResult {
  files: MultipartFile[];
  /** Non-file text fields (e.g. name, sourceId). */
  fields: Record<string, string>;
  cleanup: () => Promise<void>;
}

export function isMultipart(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").includes("multipart/form-data");
}

/**
 * Parse a multipart request, streaming file parts to temp files. Keeps only a
 * small rolling buffer in memory (the current chunk + a boundary-sized tail).
 */
export async function parseMultipart(req: IncomingMessage): Promise<MultipartResult> {
  const ct = req.headers["content-type"] ?? "";
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new Error("multipart: missing boundary");
  const boundary = `--${m[1] ?? m[2]}`;
  const boundaryBuf = Buffer.from(boundary);

  const dir = await mkdtemp(join(tmpdir(), "ps-agent-upload-"));
  const files: MultipartFile[] = [];
  const fields: Record<string, string> = {};
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    let buf = Buffer.alloc(0);
    let state: "preamble" | "headers" | "body" = "preamble";
    let current: {
      field: string;
      filename?: string;
      stream?: ReturnType<typeof createWriteStream>;
      size: number;
      text?: Buffer[];
    } | null = null;
    let fileIdx = 0;

    const finishPart = async () => {
      if (!current) return;
      if (current.filename != null) {
        await new Promise<void>((resolve, reject) => {
          current!.stream!.end((err: unknown) => (err ? reject(err as Error) : resolve()));
        });
        files.push({
          field: current.field,
          filename: current.filename,
          path: join(dir, `part-${fileIdx}`),
          size: current.size,
        });
        fileIdx++;
      } else {
        fields[current.field] = Buffer.concat(current.text ?? []).toString("utf8");
      }
      current = null;
    };

    const openPart = (headers: string) => {
      const cd = /content-disposition:[^\n]*/i.exec(headers)?.[0] ?? "";
      const field = /name="([^"]*)"/i.exec(cd)?.[1] ?? "";
      const filenameMatch = /filename="([^"]*)"/i.exec(cd);
      if (filenameMatch) {
        const path = join(dir, `part-${fileIdx}`);
        current = {
          field,
          filename: basename(filenameMatch[1] ?? `file-${fileIdx}`),
          stream: createWriteStream(path),
          size: 0,
        };
      } else {
        current = { field, size: 0, text: [] };
      }
    };

    for await (const chunk of req) {
      buf = Buffer.concat([buf, chunk as Buffer]);

      let progress = true;
      while (progress) {
        progress = false;

        if (state === "preamble" || state === "headers") {
          if (state === "preamble") {
            const bIdx = buf.indexOf(boundaryBuf);
            if (bIdx < 0) break;
            buf = buf.subarray(bIdx + boundaryBuf.length);
            state = "headers";
            progress = true;
            continue;
          }
          // headers: find blank line (\r\n\r\n)
          const hEnd = buf.indexOf("\r\n\r\n");
          if (hEnd < 0) break;
          // Skip the CRLF right after the boundary if present.
          let hStart = 0;
          if (buf[0] === 0x0d && buf[1] === 0x0a) hStart = 2;
          // "--" after boundary means end of multipart.
          if (buf[0] === 0x2d && buf[1] === 0x2d) {
            await finishPart();
            return { files, fields, cleanup };
          }
          const headers = buf.subarray(hStart, hEnd).toString("utf8");
          openPart(headers);
          buf = buf.subarray(hEnd + 4);
          state = "body";
          progress = true;
          continue;
        }

        // body: write bytes until the next boundary. Keep a tail of
        // boundary.length+2 bytes in case the boundary spans chunks.
        const nextB = buf.indexOf(boundaryBuf);
        if (nextB < 0) {
          const keep = boundaryBuf.length + 2;
          if (buf.length > keep) {
            const flush = buf.subarray(0, buf.length - keep);
            writeBody(current!, flush);
            buf = buf.subarray(buf.length - keep);
          }
          break;
        }
        // Body ends 2 bytes (\r\n) before the boundary.
        const bodyEnd = nextB >= 2 ? nextB - 2 : nextB;
        writeBody(current!, buf.subarray(0, bodyEnd));
        await finishPart();
        buf = buf.subarray(nextB + boundaryBuf.length);
        state = "headers";
        progress = true;
      }
    }

    await finishPart();
    return { files, fields, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function writeBody(
  part: { stream?: ReturnType<typeof createWriteStream>; size: number; text?: Buffer[] },
  data: Buffer,
): void {
  if (data.length === 0) return;
  part.size += data.length;
  if (part.stream) part.stream.write(data);
  else part.text?.push(data);
}

function basename(name: string): string {
  // Browsers may send a relative path (webkitdirectory) — keep only the leaf.
  const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return i >= 0 ? name.slice(i + 1) : name;
}
