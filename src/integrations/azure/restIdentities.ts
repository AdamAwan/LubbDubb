import { withApiVersion, type AzureTransport } from './azureTransport.js';

const IDENTITY_PICKER_API_VERSION = '5.0-preview.1';

/** People in the organisation a search matches, by name or mail: `localId` is what a reviewer is added by. */
export async function searchIdentities(
  http: AzureTransport,
  orgUrl: string,
  query: string,
): Promise<{ id: string; name: string }[]> {
  const data = await http.request<{
    results?: { identities?: { localId?: string | null; displayName?: string | null }[] }[];
  }>(withApiVersion(`${orgUrl}/_apis/IdentityPicker/Identities`, {}, IDENTITY_PICKER_API_VERSION), {
    method: 'POST',
    body: JSON.stringify({
      query,
      identityTypes: ['user'],
      operationScopes: ['ims', 'source'],
      options: { MinResults: 1, MaxResults: 20 },
      properties: ['DisplayName', 'Mail'],
    }),
  });
  return (data.results ?? [])
    .flatMap((r) => r.identities ?? [])
    .flatMap((i) => (i.localId ? [{ id: i.localId, name: i.displayName || i.localId }] : []));
}
