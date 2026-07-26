import { resolveChatCompletionsUrl } from "./openai.js";

export function endpointOriginPattern(baseUrl) {
  const endpoint = new URL(resolveChatCompletionsUrl(baseUrl));
  return `${endpoint.origin}/*`;
}

function requestPermissionState(browserApi, baseUrl) {
  if (!browserApi?.permissions?.request) return Promise.resolve(true);
  const descriptor = { origins: [endpointOriginPattern(baseUrl)] };
  let priorState = Promise.resolve(null);
  if (browserApi.permissions.contains) {
    try {
      priorState = Promise.resolve(
        browserApi.permissions.contains(descriptor),
      ).catch(() => null);
    } catch {
      priorState = Promise.resolve(null);
    }
  }
  const request = Promise.resolve(browserApi.permissions.request(descriptor));
  return Promise.all([priorState, request]).then(([wasPresent, requested]) => ({
    allowed: requested === true || wasPresent === true,
    wasPresent,
  }));
}

export async function requestEndpointPermission(browserApi, baseUrl) {
  if (!browserApi?.permissions?.request) return true;
  return (await requestPermissionState(browserApi, baseUrl)).allowed;
}

export async function requestEndpointPermissionWithPriorState(browserApi, baseUrl) {
  if (!browserApi?.permissions?.request) {
    return { allowed: true, wasPresent: null };
  }
  return requestPermissionState(browserApi, baseUrl);
}

export function removeEndpointPermission(browserApi, baseUrl) {
  if (!browserApi?.permissions?.remove || !baseUrl) return Promise.resolve(false);
  return browserApi.permissions.remove({
    origins: [endpointOriginPattern(baseUrl)],
  });
}
