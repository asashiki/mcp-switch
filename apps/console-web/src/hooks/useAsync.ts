import { useEffect, useState, useCallback, DependencyList } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: DependencyList = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [ver, setVer] = useState(0);

  const reload = useCallback(() => setVer(v => v + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then((d) => {
      if (!alive) return;
      setData(d);
      setLoading(false);
    }).catch((e) => {
      if (!alive) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setLoading(false);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ver]);

  return { data, loading, error, reload };
}
