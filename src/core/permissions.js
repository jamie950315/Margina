import { resolveChatCompletionsUrl } from "./openai.js";

export function endpointOriginPattern(baseUrl) {
  const endpoint = new URL(resolveChatCompletionsUrl(baseUrl));
  return `${endpoint.origin}/*`;
}

export async function requestEndpointPermissionWithPriorState(browserApi, baseUrl) {
  const descriptor = { origins: [endpointOriginPattern(baseUrl)] };
  // Both calls start in the click handler: awaiting contains first loses Safari's user gesture.
  const [wasPresent, requested] = await Promise.all([
    browserApi.permissions.contains(descriptor),
    browserApi.permissions.request(descriptor),
  ]);
  return {
    allowed: requested === true || wasPresent === true,
    wasPresent,
  };
}

export async function requestEndpointPermission(browserApi, baseUrl) {
  return (await requestEndpointPermissionWithPriorState(browserApi, baseUrl)).allowed;
}

export function removeEndpointPermission(browserApi, baseUrl) {
  return browserApi.permissions.remove({
    origins: [endpointOriginPattern(baseUrl)],
  });
}
