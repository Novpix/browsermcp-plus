import { vi } from "vitest";

// Keep test output readable; set DEBUG=1 to see server logs.
if (!process.env.DEBUG) vi.spyOn(console, "error").mockImplementation(() => {});
