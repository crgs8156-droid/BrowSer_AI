import { useState } from 'react';

export function App() {
  const [context, setContext] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshContext = async () => {
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({ type: 'COLLECT_DOM_CONTEXT' });
      if (response.error) {
        setError(response.error);
      } else {
        setContext(response.context.map((el: any) => `${el.tagName}: ${el.textContent}`));
      }
    } catch (err) {
      setError('Failed to collect context.');
    }
  };

  return (
    <main className="p-4 text-sm">
      <h1 className="text-base font-semibold">PrivAgent</h1>
      <p className="mt-1 text-neutral-500">Privacy-preserving AI browser agent</p>
      <button
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
        onClick={refreshContext}
      >
        Refresh Context
      </button>
      {error && <p className="mt-2 text-red-500">{error}</p>}
      <ul className="mt-4">
        {context.map((item, index) => (
          <li key={index} className="text-neutral-700">
            {item}
          </li>
        ))}
      </ul>
    </main>
  );
}
