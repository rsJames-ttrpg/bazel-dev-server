import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <>
      <h1>Hello from Bazel</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
    </>
  );
}
