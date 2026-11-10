// Reuse the installed platform definitions without adding Workers globals to
// the Node build. workers-types' ambient module is otherwise module-scoped.
declare module "cloudflare:workers" {
  export const DurableObject: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.DurableObject;
}
