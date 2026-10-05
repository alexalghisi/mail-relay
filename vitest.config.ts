import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // Test files share one database and truncate it between tests.
        fileParallelism: false,
        testTimeout: 20_000,
        hookTimeout: 20_000,
    },
});
