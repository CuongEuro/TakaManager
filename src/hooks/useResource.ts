"use client";

import { useCallback, useEffect, useState } from "react";

export function useResource<T>(url: string) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(url);
      setItems(await r.json());
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(
    async (body: unknown) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      return r;
    },
    [url, load]
  );

  const update = useCallback(
    async (id: string, body: unknown) => {
      const r = await fetch(`${url}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      return r;
    },
    [url, load]
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`${url}/${id}`, { method: "DELETE" });
      await load();
    },
    [url, load]
  );

  return { items, loading, load, create, update, remove };
}
