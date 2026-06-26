import { NextRequest } from "next/server";
import {
  syncStore,
  listSyncableStoreIds,
  SyncResult,
  SyncProgress,
} from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Streams newline-delimited JSON (NDJSON) progress events while syncing, so the
// UI can show a live progress bar. Lines:
//   { type: "progress", ...SyncProgress, overall, storeIndex?, storeCount? }
//   { type: "result", results: SyncResult[] }
//   { type: "error", error }
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const sinceDays = b.sinceDays ? Number(b.sinceDays) : undefined;
  const since = b.since ? new Date(String(b.since)) : undefined;
  const oid = session.oid;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        const ids = b.storeId
          ? [String(b.storeId)]
          : await listSyncableStoreIds(oid);

        if (ids.length === 0) {
          send({
            type: "error",
            error: "Chưa có store nào đủ điều kiện đồng bộ (cần domain + khoá).",
          });
          controller.close();
          return;
        }

        const results: SyncResult[] = [];
        const n = ids.length;
        for (let i = 0; i < n; i++) {
          const onProgress = (p: SyncProgress) =>
            send({
              type: "progress",
              ...p,
              // overall % across all stores being synced
              overall: Math.round((i * 100 + p.percent) / n),
              storeIndex: i + 1,
              storeCount: n,
            });
          results.push(
            await syncStore(ids[i], oid, { sinceDays, since, onProgress })
          );
        }
        send({ type: "result", results });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
