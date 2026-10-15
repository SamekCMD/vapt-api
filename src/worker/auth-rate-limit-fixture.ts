import { probeWorkerAuthRateLimit } from "./auth-rate-limit-test-support.js";

export default {
  async fetch() {
    return Response.json({ nodeEnvProduction: process.env.NODE_ENV === "production",
      preview: await probeWorkerAuthRateLimit("preview", "203.0.113.41", "203.0.113.42"),
      production: await probeWorkerAuthRateLimit("production", "203.0.113.43", "203.0.113.44") });
  },
};
