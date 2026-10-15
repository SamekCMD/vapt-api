export function assertPreviewIdentity(result) {
  if (result?.ok !== true || result.database !== "vapt" || result.user !== "vapt_api_preview") {
    throw new Error("Preview identity assertion failed");
  }
  return { database: "vapt", user: "vapt_api_preview" };
}

export function assertTransaction(result) {
  if (result?.ok !== true || result.rollbackAbsent !== true ||
    result.committedVisible !== true || result.cleaned !== true) {
    throw new Error("Preview transaction assertion failed");
  }
  return true;
}

export function assertCacheDisabledResource(config, expectedHost) {
  if (!/^[a-z0-9]{32}$/i.test(config?.id ?? "") ||
    config.caching?.disabled !== true ||
    typeof expectedHost !== "string" || expectedHost.includes("-pooler") ||
    config.origin?.host !== expectedHost ||
    config.origin?.database !== "vapt" ||
    config.origin?.user !== "vapt_api_preview" ||
    config.origin?.port !== 5432) {
    throw new Error("Preview Hyperdrive resource assertion failed");
  }
  return config.id;
}

export function safeSummary(result) {
  const identity = assertPreviewIdentity({ ok: true, ...result.identity });
  assertTransaction({ ok: true, ...result.transaction });
  return {
    database: identity.database,
    user: identity.user,
    rollbackAbsent: true,
    committedVisible: true,
    cleaned: true,
  };
}
