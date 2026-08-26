import React, { useState, useEffect } from "react";
import { render, Text, Box } from "ink";
let ticks = 0;
const App = () => {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((v) => v + 1), 300); return () => clearInterval(t); }, []);
  return <Box flexDirection="column"><Text>INK-LIVE-FRAME n={n}</Text><Text>type… prompt</Text></Box>;
};
const { unmount } = render(<App />);
setTimeout(() => { console.log("\nDONE-RENDER"); unmount(); }, 2500);
