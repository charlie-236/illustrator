/**
 * Resolves a Generation record's `filePath` to a fetchable URL.
 * Current writes use `/api/images/<filename>`. Legacy `/generations/<filename>`
 * paths are remapped to the same route for backward compatibility.
 */
export function imgSrc(filePath: string): string {
  return filePath.startsWith('/generations/')
    ? `/api/images/${filePath.slice('/generations/'.length)}`
    : filePath;
}
