import React, { useState, useEffect } from "react";
import { render, Text, Box } from "ink";
console.log("isTTY:", process.stdout.isTTY, "columns:", process.stdout.columns, "rows:", process.stdout.rows, "term:", process.env.TERM);
setInterval(() => { process.stdout.write("RAW-WRITE\r\n"); }, 500);
const App = () => {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((v) => v + 1), 300); return () => clearInterval(t); }, []);
  return <Box flexDirection="column"><Text>INK-LIVE-FRAME n={n}</Text></Box>;
};
const { unmount } = render(<App />);
setTimeout(() => { process.stdout.write("DONE\r\n"); unmount(); }, 2500);
