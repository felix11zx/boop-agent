import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    SENDBLUE_INBOX_CAPABILITY: v.optional(v.string()),
  },
});
