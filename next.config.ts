import type { NextConfig } from "next";

const config: NextConfig = {
  // The chat route reads the data store snapshot from disk, so ship those files with the function.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/corpus/meta.json", "./data/corpus/chunks.json*", "./data/corpus/embeddings.*"],
  },
  // Corpus-building and eval code is not part of the app bundle.
  outputFileTracingExcludes: {
    "*": ["./.cache/**", "./data/corpus/text/**", "./data/inventory/**", "./eval/**"],
  },
  poweredByHeader: false,
};

export default config;
