import { useEffect, useState } from "react";

type HelloResponse = {
  message: string;
  location: string;
  deals: Array<{ restaurant: string; deal: string; expires: string }>;
};

export default function App() {
  const [data, setData] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hello")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HelloResponse>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main>
      <header>
        <h1>Daily Eats</h1>
        <p className="tagline">Lunch under $10, near you.</p>
      </header>

      {error && <p className="error">Could not reach API: {error}</p>}

      {!error && !data && <p>Loading…</p>}

      {data && (
        <section>
          <p className="hello">{data.message}</p>
          <p className="loc">📍 {data.location}</p>
          <ul className="deals">
            {data.deals.map((d, i) => (
              <li key={i}>
                <strong>{d.restaurant}</strong>
                <span>{d.deal}</span>
                <small>expires {d.expires}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
