import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import App from "./App.js";
import Brand from "./Brand.js";
import { Engine } from "../engine.js";
import { PROVIDERS } from "../providers/index.js";

const ACCENT: Record<string, string> = { codex: "greenBright", claude: "magentaBright" };
const ICON: Record<string, string> = { codex: "◆", claude: "✦" };

export default function Root({ engineRef }: { engineRef?: { current: Engine | null } }) {
  const { exit } = useApp();
  const [idx, setIdx] = useState(0);
  const [chosen, setChosen] = useState<Engine | null>(null);

  useInput(
    (char, key) => {
      if (chosen) return;
      if (key.upArrow || char === "k") setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || char === "j") setIdx((i) => Math.min(PROVIDERS.length - 1, i + 1));
      else if (char >= "1" && char <= String(PROVIDERS.length)) {
        const i = Number(char) - 1;
        if (PROVIDERS[i]) { const e = new Engine(PROVIDERS[i]); if (engineRef) engineRef.current = e; setChosen(e); }
      } else if (key.return) { const e = new Engine(PROVIDERS[idx]); if (engineRef) engineRef.current = e; setChosen(e); }
      else if (char === "q" || key.escape || (key.ctrl && char === "c")) exit();
    },
    { isActive: !chosen },
  );

  if (chosen) return <App engine={chosen} onBack={() => setChosen(null)} />;

  return (
    <Box flexDirection="column">
      <Brand subtitle="Switch between all your Codex & Claude logins in one keystroke." />
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0}>
        <Text dimColor>Choose a provider</Text>
        <Box height={1} />
        {PROVIDERS.map((p, i) => {
          const sel = i === idx;
          const accent = ACCENT[p.id] ?? "white";
          const live = p.isLoggedIn();
          return (
            <Box key={p.id}>
              <Text color={sel ? accent : "gray"}>{sel ? "▌ " : "  "}</Text>
              <Text color={accent}>{`${ICON[p.id] ?? "•"} `}</Text>
              <Text bold={sel} color={sel ? "whiteBright" : "white"}>
                {`${i + 1}  ${p.label}`}
              </Text>
              <Text color={live ? "green" : "gray"}>{live ? "  ● logged in" : "  ○ not logged in"}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · 1–{PROVIDERS.length} jump · enter select · q quit</Text>
      </Box>
    </Box>
  );
}
