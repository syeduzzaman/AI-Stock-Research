import { useCallback, useEffect, useState } from "react";

export async function request(path, { method = "GET", input, signal } = {}) {
  const response = await fetch(path, {
    method, signal, credentials: "same-origin", cache: "no-store",
    headers: input === undefined ? undefined : { "Content-Type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export function useResource(api, path) {
  const [state, setState] = useState({});
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setState({ path, version, data }); },
      error => {
        if (!controller.signal.aborted) setState(previous => ({
          path, version, error, data: previous.path === path ? previous.data : undefined,
        }));
      },
    );
    return () => controller.abort();
  }, [api, path, version]);

  return { ...(path && state.path === path && state.version === version ? state : { loading: Boolean(path), data: state.path === path ? state.data : undefined }), reload };
}
