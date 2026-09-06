// → docs/spec/07-pull-requests.md#naming-a-pull-request

export type PrRefStyle = '#' | '!';

export function prRefStyle(sourceControl: string): PrRefStyle {
  return sourceControl === 'azure' ? '!' : '#';
}

export function prRef(number: number, style: PrRefStyle): string {
  return `${style}${number}`;
}
