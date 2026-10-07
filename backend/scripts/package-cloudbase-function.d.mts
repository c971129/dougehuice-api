export function assertFunctionPackage(
  root: string,
  options?: { includeSeedEntrypoint?: boolean },
): Promise<void>;
export function assertNoForbiddenFiles(root: string, relative?: string): Promise<void>;
export function pruneFunctionPackage(
  root: string,
  relative?: string,
  options?: { includeSeedEntrypoint?: boolean },
): Promise<void>;
