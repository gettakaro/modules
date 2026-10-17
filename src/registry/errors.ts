export interface RegistryError {
  /** Repository-relative path the error is about. */
  path: string;
  message: string;
}

export function formatError(error: RegistryError): string {
  return `${error.path}: ${error.message}`;
}
