export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const canRetryWithTsExtension =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith(".") || specifier.startsWith("/")) &&
      !/\.[cm]?[jt]sx?$/.test(specifier);

    if (!canRetryWithTsExtension) {
      throw error;
    }

    return nextResolve(`${specifier}.ts`, context);
  }
}
