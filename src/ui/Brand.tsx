import React from "react";
import { Box, Text } from "ink";
import { currentVersion } from "../version.js";

/** Compact brand line shown at the top of the chooser and dashboard. */
export default function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="yellowBright">⚡ </Text>
        <Text bold color="whiteBright">claude</Text>
        <Text bold color="magentaBright">codex</Text>
        <Text dimColor>{`  v${currentVersion()}`}</Text>
      </Box>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}
