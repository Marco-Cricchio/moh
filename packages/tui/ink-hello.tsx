import React, { useEffect, useState } from "react";
import { render, Text, Box, Static, useInput } from "ink";
console.log("cols:", process.stdout.columns, "rows:", process.stdout.rows);
const App = () => {
  const [n, setN] = useState(0);
  const [typed, setTyped] = useState("");
  useInput((input) => { if (input) setTyped((t) => t + input); });
  useEffect(() => { const t = setInterval(() => setN((v) => v + 1), 300); return () => clearInterval(t); }, []);
  return (
    <>
      <Static items={[{ id: 1, text: "STATIC-ITEM-ONE" }]}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      <Box flexDirection="column"><Text>LIVE n={n} typed={typed || "-"}</Text></Box>
    </>
  );
};
render(<App />, { exitOnCtrlC: false });
setTimeout(() => process.exit(0), 3000);
