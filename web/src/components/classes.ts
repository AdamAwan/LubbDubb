/** A `className` from the parts that apply; a falsy or empty part is left out. */
export function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}
